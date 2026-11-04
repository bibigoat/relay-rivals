import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createGame, joinGame, startGame, applyAction, chooseBotAction, publicState } from './engine.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY = 8192;
const IDLE_MS = 2 * 60 * 60 * 1000;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }

async function readJson(req) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw httpError('Use Content-Type: application/json.', 415);
  if (Number(req.headers['content-length']) > MAX_BODY) throw httpError('Request body exceeds 8 KB.', 413);
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw httpError('Request body exceeds 8 KB.', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw httpError('Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError('Send a JSON object.');
  return body;
}

function authorizedPlayer(req, game) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) throw httpError('Player token required.', 401);
  const token = Buffer.from(header.slice(7));
  const player = game.players.find((p) => {
    const expected = Buffer.from(p.token);
    return token.length === expected.length && timingSafeEqual(token, expected);
  });
  if (!player || player.bot) throw httpError('Invalid player token.', 401);
  return player;
}

export function createRelayServer({ maxRooms = 100, tickMs = 200, publicDir = PUBLIC, clock = Date.now } = {}) {
  const rooms = new Map();
  const rate = new Map();
  let lastSweep = 0;
  function rateLimit(req, now, pathname) {
    const key = req.socket.remoteAddress || 'unknown';
    let bucket = rate.get(key);
    if (!bucket || now - bucket.at >= 60_000) {
      bucket = { at: now, all: 0, writes: 0, creates: 0 };
      rate.set(key, bucket);
    }
    bucket.all += 1;
    if (req.method === 'POST') bucket.writes += 1;
    if (req.method === 'POST' && pathname === '/api/rooms') bucket.creates += 1;
    if (bucket.all > 600 || bucket.writes > 90 || bucket.creates > 15) throw httpError('Too many requests. Try again in a minute.', 429);
  }
  function sweep(now) {
    for (const [code, game] of rooms) if (now - game.updatedAt > IDLE_MS) rooms.delete(code);
    for (const [key, bucket] of rate) if (now - bucket.at > 120_000) rate.delete(key);
    lastSweep = now;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const json = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      let url;
      try { url = new URL(req.url, 'http://localhost'); }
      catch { throw httpError('Invalid request URL.'); }
      const pathname = url.pathname;
      const now = clock();
      if (now - lastSweep >= 60_000) sweep(now);
      rateLimit(req, now, pathname);
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin) {
          let originHost;
          try { originHost = new URL(origin).host; } catch { throw httpError('Invalid request origin.', 403); }
          if (originHost !== req.headers.host) throw httpError('Cross-origin writes are not allowed.', 403);
        }
      }
      if (pathname === '/api/health' && req.method === 'GET') return json({ ok: true, service: 'relay-rivals', storage: 'memory', rooms: rooms.size });
      if (pathname === '/api/rooms' && req.method === 'POST') {
        const body = await readJson(req);
        if (rooms.size >= maxRooms) throw httpError('Room capacity reached. Please try later.', 503);
        let code;
        do { code = randomBytes(4).toString('hex').toUpperCase(); } while (rooms.has(code));
        const game = createGame({ code, seats: body.seats ?? 2, name: body.name });
        game.createdAt = now;
        game.updatedAt = now;
        rooms.set(code, game);
        const player = game.players[0];
        return json({ code, playerId: player.id, token: player.token, state: publicState(game) }, 201);
      }
      const roomRoute = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9]{4,10})(?:\/(join|start|actions|replay))?$/);
      if (roomRoute) {
        const game = rooms.get(roomRoute[1].toUpperCase());
        if (!game) throw httpError('Room not found or expired.', 404);
        const action = roomRoute[2];
        if (!action && req.method === 'GET') return json(publicState(game));
        if (action === 'replay' && req.method === 'GET') return json({ initial: game.initial, events: game.events, final: publicState(game) });
        if (action === 'join' && req.method === 'POST') {
          const body = await readJson(req);
          const player = joinGame(game, { name: body.name });
          game.updatedAt = now;
          return json({ code: game.code, playerId: player.id, token: player.token, state: publicState(game) }, 201);
        }
        if (action === 'start' && req.method === 'POST') {
          const player = authorizedPlayer(req, game);
          if (player.id !== game.hostPlayerId) throw httpError('Only the host can start this room.', 403);
          await readJson(req);
          startGame(game, { now });
          return json(publicState(game));
        }
        if (action === 'actions' && req.method === 'POST') {
          const player = authorizedPlayer(req, game);
          const body = await readJson(req);
          if (game.status === 'playing' && now >= game.deadline) {
            const timedOutId = game.turnPlayerId;
            applyAction(game, timedOutId, chooseBotAction(game), { now, automatic: true });
            throw httpError('The turn timer expired. Refresh the board.', 409);
          }
          applyAction(game, player.id, body, { now });
          return json(publicState(game));
        }
        throw httpError('Method not allowed.', 405);
      }
      if (pathname.startsWith('/api/')) throw httpError('Endpoint not found.', 404);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError('Method not allowed.', 405);
      const asset = pathname === '/' ? 'index.html' : pathname.slice(1);
      // Only flat named public assets. No traversal, secret files, or arbitrary disk reads.
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(asset) || asset.includes('..') || !MIME[extname(asset)]) throw httpError('Not found.', 404);
      let bytes;
      try { bytes = await readFile(join(publicDir, asset)); }
      catch (error) { if (error.code === 'ENOENT') throw httpError('Not found.', 404); throw error; }
      res.writeHead(200, { 'Content-Type': MIME[extname(asset)], 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json({ error: error.status ? error.message : 'Internal server error.' }, error.status || 500);
      else if (!res.destroyed) res.end();
      if (!error.status) console.error('Relay Rivals request error:', error);
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const timer = setInterval(() => {
    const now = clock();
    if (now - lastSweep >= 60_000) sweep(now);
    for (const game of rooms.values()) {
      if (game.status !== 'playing') continue;
      const player = game.players.find((p) => p.id === game.turnPlayerId);
      if (now >= game.deadline || (player.bot && now >= game.nextBotAt)) {
        try { applyAction(game, player.id, chooseBotAction(game), { now, automatic: true }); }
        catch (error) { console.error('Relay Rivals timer error:', error); }
      }
    }
  }, tickMs);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
  const server = createRelayServer();
  server.listen(port, host, () => console.log(`Relay Rivals listening at http://${host}:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
