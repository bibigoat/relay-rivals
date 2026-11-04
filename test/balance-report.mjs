// A reproducible comparison of simple policies, not a proof of game balance.
import { createGame, joinGame, startGame, applyAction, chooseBotAction, publicState } from '../engine.mjs';
import { chooseAction } from '../sample-bot.mjs';

const policies = {
  builtIn: (game) => chooseBotAction(game),
  sample: (game) => chooseAction(publicState(game), game.turnPlayerId),
  bank: (game) => ({ type: game.players.find(p => p.id === game.turnPlayerId).energy >= 3 ? 'bank' : 'charge' }),
  surge: (game) => contest(game, 'surge', 4, 3),
  deploy: (game) => contest(game, 'deploy', 2, 1),
};
function contest(game, type, cost, increase) {
  const index = game.players.findIndex(p => p.id === game.turnPlayerId);
  if (game.players[index].energy < cost) return { type: 'charge' };
  const targets = game.sectors.map(sector => {
    const own = sector.influence[index];
    const other = Math.max(...sector.influence.filter((_, i) => i !== index));
    const value = sector.value + (sector.id === game.spotlight ? 2 : 0);
    return { sector: sector.id, utility: (own <= other && own + increase > other ? value : 0) - own * 0.1 };
  }).sort((a, b) => b.utility - a.utility);
  return { type, sector: targets[0].sector };
}
function permutations(values, length) {
  if (!length) return [[]];
  return values.flatMap(value => permutations(values.filter(other => other !== value), length - 1).map(rest => [value, ...rest]));
}
const report = { caveat: 'Deterministic small policy comparison; no human play-test, optimal-play proof or confidence estimate.', seats: {} };
for (const seats of [2, 3, 4]) {
  const stats = Object.fromEntries(Object.keys(policies).map(name => [name, { games: 0, winShare: 0, points: 0 }]));
  const lineups = permutations(Object.keys(policies), seats);
  for (const lineup of lineups) {
    const game = createGame({ code: 'BALANCE', seats, name: lineup[0] });
    for (const name of lineup.slice(1)) joinGame(game, { name });
    startGame(game, { now: 1000 });
    let turns = 0;
    while (game.status === 'playing') {
      if (++turns > 32) throw new Error('Nonterminating match');
      const player = game.players.find(p => p.id === game.turnPlayerId);
      const action = policies[player.name](game);
      applyAction(game, player.id, { ...action, expectedVersion: game.version }, { now: 1000 + turns });
    }
    for (const player of game.players) {
      const stat = stats[player.name];
      stat.games++;
      stat.points += player.score;
      if (game.winnerIds.includes(player.id)) stat.winShare += 1 / game.winnerIds.length;
    }
  }
  report.seats[seats] = { matches: lineups.length, policies: Object.fromEntries(Object.entries(stats).map(([name, stat]) => [name, {
    ...stat, meanPoints: Number((stat.points / stat.games).toFixed(2)), winShareRate: Number((stat.winShare / stat.games).toFixed(3)),
  }])) };
}
console.log(JSON.stringify(report, null, 2));
