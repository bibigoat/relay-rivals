import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, joinGame, startGame, applyAction, chooseBotAction, publicState } from '../engine.mjs';
import { chooseAction } from '../sample-bot.mjs';

function playing(seats = 2) {
  const game = createGame({ code: 'TESTAA', seats, name: 'Host' });
  for (let i = 1; i < seats; i++) joinGame(game, { name: `Guest ${i}` });
  startGame(game, { now: 1000 });
  return game;
}
function move(game, action) {
  applyAction(game, game.turnPlayerId, { ...action, expectedVersion: game.version }, { now: 1100 });
}
function safeSnapshot(game) { return structuredClone(publicState(game)); }

test('lobby fills empty seats with bots and never exposes bearer credentials', () => {
  const game = createGame({ code: 'SAFEAA', seats: 4, name: 'Host' });
  joinGame(game, { name: 'Human guest' });
  const secrets = game.players.map(p => p.token);
  startGame(game, { now: 1000 });
  assert.equal(game.players.length, 4);
  assert.equal(game.players.filter(p => p.bot).length, 2);
  const serialized = JSON.stringify(publicState(game));
  for (const secret of secrets) assert.ok(secret && !serialized.includes(secret));
  assert.ok(!serialized.includes('"token"'));
});

test('stale versions, wrong turns and invalid actions leave state unchanged', () => {
  const game = playing();
  const original = safeSnapshot(game);
  const other = game.players.find(p => p.id !== game.turnPlayerId);
  const attempts = [
    () => applyAction(game, game.turnPlayerId, { type: 'charge', expectedVersion: game.version - 1 }),
    () => applyAction(game, other.id, { type: 'charge', expectedVersion: game.version }),
    () => applyAction(game, game.turnPlayerId, { type: 'unknown', expectedVersion: game.version }),
    () => applyAction(game, game.turnPlayerId, { type: 'deploy', sector: -1, expectedVersion: game.version }),
    () => applyAction(game, game.turnPlayerId, { type: 'surge', sector: 0.5, expectedVersion: game.version }),
    () => applyAction(game, game.turnPlayerId, { type: 'deploy', sector: 5, expectedVersion: game.version }),
    () => applyAction(game, game.turnPlayerId, { type: 'charge' }),
  ];
  for (const attempt of attempts) {
    assert.throws(attempt);
    assert.deepEqual(publicState(game), original);
  }
});

test('energy costs, cap, and insufficient funds are enforced', () => {
  const game = playing();
  game.players[0].energy = 1;
  assert.throws(() => move(game, { type: 'deploy', sector: 0 }));
  assert.equal(game.players[0].energy, 1);
  game.players[0].energy = 7;
  move(game, { type: 'charge' });
  assert.equal(game.players[0].energy, 8);
  game.players[1].energy = 4;
  move(game, { type: 'surge', sector: 1 });
  // Round completion applies a +2 recharge and one influence decay.
  assert.equal(game.players[1].energy, 2);
  assert.equal(game.sectors[1].influence[1], 2);
});

test('ties score nothing; a unique spotlight leader scores the advertised bonus', () => {
  const tied = playing();
  tied.sectors[0].influence = [2, 2];
  move(tied, { type: 'charge' });
  move(tied, { type: 'charge' });
  assert.deepEqual(tied.players.map(p => p.score), [0, 0]);
  assert.deepEqual(tied.sectors[0].influence, [1, 1]);
  const won = playing();
  const value = won.sectors[0].value;
  won.sectors[0].influence = [3, 1];
  move(won, { type: 'charge' });
  move(won, { type: 'charge' });
  assert.equal(won.players[0].score, value + 2);
  assert.equal(won.players[1].score, 0);
  assert.deepEqual(won.sectors[0].influence, [2, 0]);
});

test('disruption cannot target self or an empty rival and cannot produce negative influence', () => {
  const game = playing();
  const own = game.players[0];
  const enemy = game.players[1];
  own.energy = 8;
  assert.throws(() => move(game, { type: 'disrupt', sector: 0, targetPlayer: own.id }));
  assert.throws(() => move(game, { type: 'disrupt', sector: 0, targetPlayer: enemy.id }));
  game.sectors[0].influence[1] = 1;
  move(game, { type: 'disrupt', sector: 0, targetPlayer: enemy.id });
  assert.equal(own.energy, 5);
  assert.equal(game.sectors[0].influence[1], 0);
});

for (const seats of [2, 3, 4]) {
  test(`${seats} players finish in eight rounds with rotating first player and shared ties`, () => {
    const game = playing(seats);
    const firsts = [];
    let actions = 0;
    while (game.status === 'playing') {
      if (actions % seats === 0) firsts.push(game.turnPlayerId);
      move(game, { type: 'charge' });
      actions++;
      assert.ok(actions <= seats * 8, 'game did not terminate');
    }
    assert.equal(game.status, 'finished');
    assert.equal(actions, seats * 8);
    assert.deepEqual(firsts, Array.from({ length: 8 }, (_, r) => game.players[r % seats].id));
    assert.deepEqual([...game.winnerIds].sort(), game.players.map(p => p.id).sort());
    assert.throws(() => move(game, { type: 'charge' }));
  });
  test(`${seats} players can finish using both independent and built-in bot policies`, () => {
    const game = playing(seats);
    let steps = 0;
    while (game.status === 'playing') {
      const action = steps % 2 ? chooseBotAction(game) : chooseAction(publicState(game), game.turnPlayerId);
      move(game, action);
      assert.ok(++steps <= seats * 8);
      for (const player of game.players) {
        assert.ok(Number.isInteger(player.score) && player.score >= 0);
        assert.ok(player.energy >= 0 && player.energy <= 8);
      }
      for (const sector of game.sectors) assert.ok(sector.influence.every(n => Number.isInteger(n) && n >= 0));
    }
    assert.ok(game.winnerIds.length >= 1);
  });
}

test('the same accepted move sequence reproduces scoring and board evolution', () => {
  const left = playing(3);
  const right = playing(3);
  while (left.status === 'playing') {
    const action = chooseAction(publicState(left), left.turnPlayerId);
    if (action.targetPlayer) {
      const i = left.players.findIndex(p => p.id === action.targetPlayer);
      move(right, { ...action, targetPlayer: right.players[i].id });
    } else move(right, action);
    move(left, action);
    assert.deepEqual(left.players.map(p => [p.energy, p.score]), right.players.map(p => [p.energy, p.score]));
    assert.deepEqual(left.sectors, right.sectors);
    assert.equal(left.round, right.round);
  }
});

function simpleSurge(game) {
  const index = game.players.findIndex(p => p.id === game.turnPlayerId);
  if (game.players[index].energy < 4) return { type: 'charge' };
  const targets = game.sectors.map(sector => {
    const own = sector.influence[index];
    const rival = Math.max(...sector.influence.filter((_, i) => i !== index));
    const reward = sector.value + (sector.id === game.spotlight ? 2 : 0);
    return { sector: sector.id, priority: (own <= rival && own + 3 > rival ? reward : 0) - own * 0.1 };
  }).sort((a, b) => b.priority - a.priority);
  return { type: 'surge', sector: targets[0].sector };
}
for (const adaptiveSeat of [0, 1]) {
  test(`adaptive tactics counter the simple surge policy from seat ${adaptiveSeat + 1}`, () => {
    const game = playing(2);
    const adaptiveId = game.players[adaptiveSeat].id;
    const choices = new Set();
    while (game.status === 'playing') {
      const before = safeSnapshot(game);
      const ours = game.turnPlayerId === adaptiveId;
      const action = ours ? chooseBotAction(game) : simpleSurge(game);
      assert.deepEqual(publicState(game), before, 'search must not mutate the real board');
      if (ours) choices.add(action.type);
      move(game, action);
    }
    assert.deepEqual(game.winnerIds, [adaptiveId]);
    assert.ok(choices.size >= 2, 'counter-policy uses different actions');
  });
}
