#!/usr/bin/env node
/** Example external player. Only the documented HTTP API is used. */
import { pathToFileURL } from 'node:url';

export function chooseAction(state, playerId) {
  const index = state.players.findIndex(player => player.id === playerId);
  if (index < 0) throw new Error('Player is not in this room');
  const player = state.players[index];
  const moves = [{ type: 'charge', utility: Math.min(3, 8 - player.energy) * 0.47 }];
  if (player.energy >= 3) moves.push({ type: 'bank', utility: 1.65 });
  for (const sector of state.sectors) {
    const own = sector.influence[index];
    const rival = Math.max(0, ...sector.influence.filter((_, i) => i !== index));
    const points = sector.value + (sector.id === state.spotlight ? 2 : 0);
    const previous = own > rival ? points : 0;
    for (const [type, cost, increase] of [['deploy', 2, 1], ['surge', 4, 3]]) {
      if (player.energy < cost) continue;
      const after = own + increase > rival ? points : 0;
      // Prefer newly won sectors; preserve useful influence for later rounds.
      const future = state.round < state.maxRounds ? Math.min(2, own + increase - rival) * 0.22 : 0;
      moves.push({ type, sector: sector.id, utility: after - previous + future - cost * 0.18 });
    }
    if (player.energy >= 3) {
      state.players.forEach((target, targetIndex) => {
        if (targetIndex === index || sector.influence[targetIndex] <= 0) return;
        const influence = sector.influence.map((value, i) => i === targetIndex ? Math.max(0, value - 2) : value);
        const afterRival = Math.max(0, ...influence.filter((_, i) => i !== index));
        const after = own > afterRival ? points : 0;
        const denyingLeader = sector.influence[targetIndex] > Math.max(own, ...sector.influence.filter((_, i) => i !== targetIndex));
        moves.push({ type: 'disrupt', sector: sector.id, targetPlayer: target.id,
          utility: after - previous + (denyingLeader ? points * 0.35 : 0) - 0.54 });
      });
    }
  }
  moves.sort((a, b) => b.utility - a.utility);
  const { utility, ...action } = moves[0];
  return { ...action, expectedVersion: state.version };
}

async function run() {
  const args = process.argv.slice(2);
  const flag = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  const positional = args[0]?.startsWith('--') ? [] : args;
  const base = (process.env.BASE_URL || flag('--url') || positional[0] || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const code = (process.env.ROOM_CODE || flag('--room') || positional[1] || '').toUpperCase();
  const name = process.env.BOT_NAME || flag('--name') || positional[2] || 'Orbit Bot';
  if (!/^[A-Z0-9]{4,12}$/.test(code)) {
    throw new Error('Usage: node sample-bot.mjs --url http://127.0.0.1:3000 --room ROOMCODE --name SampleBot');
  }
  const request = async (path, body, token) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
    return data;
  };
  const joined = await request(`/api/rooms/${code}/join`, { name });
  console.log(`Joined ${code} as ${name} (${joined.playerId}). Waiting for the host to start.`);
  const stopAt = Date.now() + 15 * 60 * 1000;
  while (Date.now() < stopAt) {
    let state;
    try {
      state = await request(`/api/rooms/${code}`);
      if (state.status === 'finished') {
        console.log(`Finished. Score: ${state.players.find(p => p.id === joined.playerId)?.score}. Winners: ${state.winnerIds.join(', ')}`);
        return;
      }
      if (state.status === 'playing' && state.turnPlayerId === joined.playerId) {
        const action = chooseAction(state, joined.playerId);
        await request(`/api/rooms/${code}/actions`, action, joined.token);
        console.log(`Round ${state.round}: ${action.type}${action.sector === undefined ? '' : ` sector ${action.sector}`}`);
      }
    } catch (error) {
      if (error.status && ![409, 429, 503].includes(error.status)) throw error;
      // A timeout may follow a successful write. Read again; never replay it blindly.
      console.error(`Refreshing state after: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 650));
  }
  throw new Error('Stopped after 15 minutes. The room may still be waiting for its host.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
