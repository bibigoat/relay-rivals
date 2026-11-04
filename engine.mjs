import { randomBytes } from 'node:crypto';

export const MAX_ROUNDS = 8;
export const TURN_MS = 15_000;
const VALUES = [2, 3, 1, 2, 1];
const NAMES = ['Harbor', 'Spire', 'Garden', 'Foundry', 'Observatory'];

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function displayName(value, fallback = 'Player') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 24) || fallback;
}

function newPlayer(name, bot = false) {
  return {
    id: randomBytes(8).toString('hex'),
    token: randomBytes(24).toString('hex'),
    name: displayName(name), bot, energy: 4, score: 0,
  };
}

function appendLog(game, text, extra = {}) {
  game.log.push({ text, round: game.round, ...extra });
  if (game.log.length > 100) game.log.shift();
}

export function createGame({ code, seats = 2, name = 'Player' } = {}) {
  if (!Number.isInteger(seats) || seats < 2 || seats > 4) fail('Choose 2, 3, or 4 seats.');
  if (typeof code !== 'string' || !/^[A-Z0-9]{4,10}$/.test(code)) fail('Invalid room code.');
  const host = newPlayer(name);
  const now = Date.now();
  return {
    code, seats, status: 'lobby', version: 1, round: 0, maxRounds: MAX_ROUNDS,
    hostPlayerId: host.id, players: [host],
    sectors: VALUES.map((value, id) => ({ id, name: NAMES[id], value, influence: [0] })),
    spotlight: 0, turnPlayerId: null, turnIndex: 0, deadline: null,
    log: [], winnerIds: [], events: [], initial: null,
    createdAt: now, updatedAt: now, nextBotAt: null,
  };
}

export function joinGame(game, { name = 'Player' } = {}) {
  if (game.status !== 'lobby') fail('This game has already started.', 409);
  if (game.players.length >= game.seats) fail('This room is full.', 409);
  const player = newPlayer(name);
  game.players.push(player);
  for (const sector of game.sectors) sector.influence.push(0);
  game.version += 1;
  game.updatedAt = Date.now();
  return player;
}

function setTurn(game, now) {
  const index = ((game.round - 1) + game.turnIndex) % game.players.length;
  game.turnPlayerId = game.players[index].id;
  game.deadline = now + TURN_MS;
  game.nextBotAt = now + 500;
}

export function startGame(game, { now = Date.now() } = {}) {
  if (game.status !== 'lobby') fail('This game has already started.', 409);
  while (game.players.length < game.seats) {
    const player = newPlayer(`Relay Bot ${game.players.filter((p) => p.bot).length + 1}`, true);
    game.players.push(player);
    for (const sector of game.sectors) sector.influence.push(0);
  }
  game.status = 'playing';
  game.round = 1;
  game.spotlight = 0;
  game.turnIndex = 0;
  game.version += 1;
  game.updatedAt = now;
  appendLog(game, 'Match started. Control relays when the round ends.');
  setTurn(game, now);
  game.initial = publicState(game);
  return game;
}

function sectorWinner(sector) {
  const highest = Math.max(...sector.influence);
  if (highest <= 0) return -1;
  const index = sector.influence.indexOf(highest);
  return sector.influence.lastIndexOf(highest) === index ? index : -1;
}

function endRound(game, now) {
  const awards = game.players.map(() => 0);
  for (const sector of game.sectors) {
    const winner = sectorWinner(sector);
    if (winner >= 0) awards[winner] += sector.value + (sector.id === game.spotlight ? 2 : 0);
    sector.influence = sector.influence.map((value) => Math.max(0, value - 1));
  }
  game.players.forEach((player, index) => { player.score += awards[index]; });
  appendLog(game, `Round ${game.round} scored: ${game.players.map((p, i) => `${p.name} +${awards[i]}`).join(' · ')}. All influence decays by 1.`, { type: 'scoring', awards });
  if (game.round === MAX_ROUNDS) {
    game.status = 'finished';
    const high = Math.max(...game.players.map((p) => p.score));
    game.winnerIds = game.players.filter((p) => p.score === high).map((p) => p.id);
    game.turnPlayerId = null;
    game.deadline = null;
    game.nextBotAt = null;
    appendLog(game, `Match finished. ${game.players.filter((p) => p.score === high).map((p) => p.name).join(' & ')} ${game.winnerIds.length === 1 ? 'wins' : 'share the win'} with ${high} points.`, { type: 'finished' });
    return;
  }
  game.round += 1;
  game.spotlight = (game.round - 1) % game.sectors.length;
  game.turnIndex = 0;
  for (const player of game.players) player.energy = Math.min(8, player.energy + 2);
  setTurn(game, now);
}

function actionDescription(game, player, action) {
  const sector = game.sectors[action.sector];
  switch (action.type) {
    case 'deploy': return `${player.name} deployed at ${sector.name} (+1 influence).`;
    case 'surge': return `${player.name} surged at ${sector.name} (+3 influence).`;
    case 'disrupt': return `${player.name} disrupted ${game.players.find((p) => p.id === action.targetPlayer).name} at ${sector.name} (−2 influence).`;
    case 'charge': return `${player.name} charged (+3 energy, cap 8).`;
    case 'bank': return `${player.name} banked 2 points.`;
    default: return '';
  }
}

function validateAction(game, playerId, action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) fail('Send an action object.');
  if (game.status !== 'playing') fail('The game is not playing.', 409);
  if (game.turnPlayerId !== playerId) fail('It is not your turn.', 409);
  if (!Number.isInteger(action.expectedVersion)) fail('expectedVersion must be an integer.');
  if (action.expectedVersion !== game.version) fail('The board changed. Refresh and try again.', 409);
  const index = game.players.findIndex((p) => p.id === playerId);
  if (index < 0) fail('Player not found.', 403);
  const player = game.players[index];
  const costs = { deploy: 2, surge: 4, disrupt: 3, charge: 0, bank: 3 };
  if (!Object.hasOwn(costs, action.type)) fail('Unknown action type.');
  if (player.energy < costs[action.type]) fail('Not enough energy.');
  if (['deploy', 'surge', 'disrupt'].includes(action.type)) {
    if (!Number.isInteger(action.sector) || action.sector < 0 || action.sector >= game.sectors.length) fail('Choose a relay from 0 to 4.');
  }
  let targetIndex = -1;
  if (action.type === 'disrupt') {
    targetIndex = game.players.findIndex((p) => p.id === action.targetPlayer);
    if (targetIndex < 0 || targetIndex === index) fail('Choose an opponent to disrupt.');
    if (game.sectors[action.sector].influence[targetIndex] <= 0) fail('That opponent has no influence at this relay.');
  }
  return { index, player, cost: costs[action.type], targetIndex };
}

export function applyAction(game, playerId, action, { now = Date.now(), automatic = false } = {}) {
  const { index, player, cost, targetIndex } = validateAction(game, playerId, action);
  const cleanAction = { type: action.type, expectedVersion: action.expectedVersion };
  if (['deploy', 'surge', 'disrupt'].includes(action.type)) cleanAction.sector = action.sector;
  if (action.type === 'disrupt') cleanAction.targetPlayer = action.targetPlayer;
  const text = actionDescription(game, player, cleanAction);
  const actionRound = game.round;
  player.energy -= cost;
  if (action.type === 'deploy') game.sectors[action.sector].influence[index] += 1;
  if (action.type === 'surge') game.sectors[action.sector].influence[index] += 3;
  if (action.type === 'disrupt') game.sectors[action.sector].influence[targetIndex] = Math.max(0, game.sectors[action.sector].influence[targetIndex] - 2);
  if (action.type === 'charge') player.energy = Math.min(8, player.energy + 3);
  if (action.type === 'bank') player.score += 2;
  appendLog(game, text, { type: 'action', playerId, automatic });
  game.version += 1;
  game.updatedAt = now;
  game.turnIndex += 1;
  if (game.turnIndex >= game.players.length) endRound(game, now);
  else setTurn(game, now);
  game.events.push({ seq: game.events.length + 1, type: 'action', round: actionRound, playerId, action: cleanAction, automatic, text, at: now, state: publicState(game) });
  return game;
}

function legalActions(game, playerId) {
  const player = game.players.find((p) => p.id === playerId);
  const actions = [{ type: 'charge' }];
  if (player.energy >= 3) actions.push({ type: 'bank' });
  for (const sector of game.sectors) {
    if (player.energy >= 2) actions.push({ type: 'deploy', sector: sector.id });
    if (player.energy >= 4) actions.push({ type: 'surge', sector: sector.id });
    if (player.energy >= 3) {
      game.players.forEach((opponent, index) => {
        if (opponent.id !== playerId && sector.influence[index] > 0) actions.push({ type: 'disrupt', sector: sector.id, targetPlayer: opponent.id });
      });
    }
  }
  return actions;
}

// Simulate only the board and counters; never copy accumulated replay history.
function botSuccessor(game, action) {
  const next = {
    ...game,
    players: game.players.map((player) => ({ ...player })),
    sectors: game.sectors.map((sector) => ({ ...sector, influence: [...sector.influence] })),
    winnerIds: [...game.winnerIds], log: [], events: [], initial: null,
  };
  applyAction(next, next.turnPlayerId, { ...action, expectedVersion: next.version }, { now: game.updatedAt });
  return next;
}

function botPositionValue(game, playerId) {
  const index = game.players.findIndex((player) => player.id === playerId);
  const advantage = (values) => values[index] - Math.max(...values.filter((_, i) => i !== index));
  let value = advantage(game.players.map((player) => player.score));
  if (game.status === 'finished') return value;
  // Estimate the current and following scoring windows, including decay and
  // the rotating spotlight. Opponents may still change those positions.
  const weights = [0.7, 0.4];
  for (let future = 0; future < weights.length && game.round + future <= MAX_ROUNDS; future++) {
    const awards = game.players.map(() => 0);
    for (const sector of game.sectors) {
      const projected = { ...sector, influence: sector.influence.map((n) => Math.max(0, n - future)) };
      const winner = sectorWinner(projected);
      if (winner >= 0) awards[winner] += sector.value + (sector.id === (game.round + future - 1) % game.sectors.length ? 2 : 0);
    }
    value += weights[future] * advantage(awards);
  }
  return value + 0.3 * advantage(game.players.map((player) => player.energy));
}

// Bounded two-ply search: our action, then the next player's strongest reply.
// At most 27 legal actions per node with four seats. No remote model is used.
export function chooseBotAction(game, playerId = game.turnPlayerId) {
  if (game.status !== 'playing' || game.turnPlayerId !== playerId) fail('No legal bot turn.', 409);
  let best = null;
  let bestValue = -Infinity;
  for (const action of legalActions(game, playerId)) {
    const after = botSuccessor(game, action);
    let value = botPositionValue(after, playerId);
    if (after.status === 'playing') {
      const replies = legalActions(after, after.turnPlayerId)
        .map((reply) => botPositionValue(botSuccessor(after, reply), playerId));
      // Rotating initiative can give the same player consecutive turns.
      value = after.turnPlayerId === playerId ? Math.max(...replies) : Math.min(...replies);
    }
    if (value > bestValue + 1e-9) { best = action; bestValue = value; }
  }
  return { ...best, expectedVersion: game.version };
}

export function publicState(game) {
  return {
    code: game.code, status: game.status, version: game.version,
    round: game.round, maxRounds: MAX_ROUNDS, seats: game.seats,
    turnPlayerId: game.turnPlayerId, deadline: game.deadline,
    hostPlayerId: game.hostPlayerId,
    players: game.players.map(({ id, name, bot, energy, score }) => ({ id, name, bot, energy, score })),
    sectors: game.sectors.map(({ id, name, value, influence }) => ({ id, name, value, influence: [...influence] })),
    spotlight: game.spotlight,
    log: game.log.map((item) => ({ ...item, ...(item.awards ? { awards: [...item.awards] } : {}) })),
    winnerIds: [...game.winnerIds],
  };
}
