import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRelayServer } from '../server.mjs';

async function app(t, options = {}) {
  let now = 1_000_000;
  const server = createRelayServer({ clock: () => now, tickMs: 10, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, token, extra = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(extra.headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  return { request, base, advance: ms => { now += ms; } };
}
async function twoPeople(request) {
  const created = await request('/api/rooms', { seats: 2, name: 'Host' });
  assert.equal(created.status, 201);
  const host = created.data;
  const joined = await request(`/api/rooms/${host.code}/join`, { name: 'Guest' });
  assert.equal(joined.status, 201);
  return { host, guest: joined.data, route: `/api/rooms/${host.code}` };
}

test('HTTP host authorization, stale-write conflict, and replay redact credentials', async t => {
  const { request } = await app(t);
  const { host, guest, route } = await twoPeople(request);
  assert.equal((await request(`${route}/start`, {})).status, 401);
  assert.equal((await request(`${route}/start`, {}, guest.token)).status, 403);
  assert.equal((await request(`${route}/start`, {}, 'wrong-token')).status, 401);
  let result = await request(`${route}/start`, {}, host.token);
  assert.equal(result.status, 200);
  const startVersion = result.data.version;
  assert.equal((await request(`${route}/actions`, { type: 'charge', expectedVersion: startVersion }, guest.token)).status, 409);
  const action = { type: 'charge', expectedVersion: startVersion, token: 'private-do-not-echo' };
  const racing = await Promise.all([
    request(`${route}/actions`, action, host.token),
    request(`${route}/actions`, action, host.token),
  ]);
  assert.deepEqual(racing.map(r => r.status).sort(), [200, 409]);
  result = await request(route);
  assert.equal(result.data.version, startVersion + 1);
  assert.equal(result.data.turnPlayerId, guest.playerId);
  const replay = await request(`${route}/replay`);
  assert.equal(replay.data.events.length, 1);
  assert.deepEqual(replay.data.final, result.data);
  assert.equal(replay.data.initial.version, startVersion);
  for (const token of [host.token, guest.token, 'private-do-not-echo']) assert.ok(!JSON.stringify(replay.data).includes(token));
  assert.ok(!JSON.stringify(replay.data).includes('"token"'));
});

test('HTTP rejects bad input, foreign-origin writes, full rooms, and late joins', async t => {
  const { request, base } = await app(t);
  assert.equal((await request('/api/rooms', { seats: 5 })).status, 400);
  assert.equal((await request('/api/rooms', { seats: 2 }, null, { headers: { origin: 'https://elsewhere.invalid' } })).status, 403);
  const malformed = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  const wrongType = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
  const { host, route } = await twoPeople(request);
  assert.equal((await request(`${route}/join`, { name: 'Third' })).status, 409);
  await request(`${route}/start`, {}, host.token);
  assert.equal((await request(`${route}/join`, { name: 'Late' })).status, 409);
  assert.equal((await request('/api/rooms/UNKNOWN')).status, 404);
});

test('a missed turn receives exactly one automatic action and a fresh deadline', async t => {
  const { request, advance } = await app(t);
  const { host, guest, route } = await twoPeople(request);
  const started = await request(`${route}/start`, {}, host.token);
  advance(15_001);
  await new Promise(resolve => setTimeout(resolve, 40));
  const state = (await request(route)).data;
  assert.equal(state.turnPlayerId, guest.playerId);
  assert.equal(state.version, started.data.version + 1);
  assert.ok(state.deadline > started.data.deadline);
  const replay = (await request(`${route}/replay`)).data;
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].automatic, true);
});

test('complete HTTP match keeps every accepted action and an immutable initial state', async t => {
  const { request } = await app(t);
  const { host, guest, route } = await twoPeople(request);
  let state = (await request(`${route}/start`, {}, host.token)).data;
  const initial = structuredClone(state);
  const tokens = new Map([[host.playerId, host.token], [guest.playerId, guest.token]]);
  for (let count = 0; state.status === 'playing'; count++) {
    assert.ok(count < 16);
    const response = await request(`${route}/actions`, { type: 'charge', expectedVersion: state.version }, tokens.get(state.turnPlayerId));
    assert.equal(response.status, 200);
    state = response.data;
  }
  assert.equal(state.status, 'finished');
  const replay = (await request(`${route}/replay`)).data;
  assert.equal(replay.events.length, 16);
  assert.deepEqual(replay.initial, initial);
  assert.deepEqual(replay.final, state);
  replay.events.forEach((event, index) => {
    assert.equal(event.seq, index + 1);
    assert.equal(event.state.version, initial.version + index + 1);
  });
  assert.equal((await request(`${route}/actions`, { type: 'charge', expectedVersion: state.version }, host.token)).status, 409);
});

test('sample HTTP bot joins, makes legal moves, and stops after a real match', { timeout: 20_000 }, async t => {
  const { request, base } = await app(t);
  const host = (await request('/api/rooms', { name: 'Bot test host', seats: 2 })).data;
  const route = `/api/rooms/${host.code}`;
  const script = fileURLToPath(new URL('../sample-bot.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--url', base, '--room', host.code, '--name', 'Test Agent'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const exited = once(child, 'exit');
  let state;
  for (let i = 0; i < 60; i++) {
    state = (await request(route)).data;
    if (state.players.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(state.players.length, 2, output);
  state = (await request(`${route}/start`, {}, host.token)).data;
  const end = Date.now() + 14_000;
  while (state.status === 'playing' && Date.now() < end) {
    if (state.turnPlayerId === host.playerId) {
      const result = await request(`${route}/actions`, { type: 'charge', expectedVersion: state.version }, host.token);
      assert.equal(result.status, 200);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    state = (await request(route)).data;
  }
  assert.equal(state.status, 'finished', output);
  const [exitCode] = await exited;
  assert.equal(exitCode, 0, output);
  assert.match(output, /Finished\. Score:/);
  const replay = (await request(`${route}/replay`)).data;
  assert.equal(replay.events.filter(event => event.playerId !== host.playerId).length, 8);
  assert.ok(replay.events.every(event => !event.automatic));
});
