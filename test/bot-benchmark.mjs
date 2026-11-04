import { performance } from 'node:perf_hooks';
import { createGame, startGame, chooseBotAction, applyAction } from '../engine.mjs';
const samples = [];
for (const seats of [2, 3, 4]) {
  const game = createGame({ code: 'BENCHAA', seats, name: 'Benchmark' });
  startGame(game, { now: 1000 });
  let count = 0;
  while (game.status === 'playing') {
    const started = performance.now();
    const action = chooseBotAction(game);
    samples.push(performance.now() - started);
    applyAction(game, game.turnPlayerId, action, { now: 1000 + count++ });
  }
}
const stress = createGame({ code: 'STRESSAA', seats: 4, name: 'Stress' });
startGame(stress, { now: 1000 });
for (const player of stress.players) player.energy = 8;
for (const sector of stress.sectors) sector.influence = [2, 3, 2, 1];
const stressSamples = [];
for (let i = 0; i < 20; i++) {
  const started = performance.now();
  chooseBotAction(stress);
  stressSamples.push(performance.now() - started);
}
function stats(values) {
  values.sort((a, b) => a - b);
  return { samples: values.length, p95ms: +values[Math.ceil(values.length * .95) - 1].toFixed(3), maxMs: +values.at(-1).toFixed(3) };
}
console.log(JSON.stringify({ runtime: process.version, completeGames: stats(samples), crowdedFourPlayerBoard: stats(stressSamples), caveat: 'Local timing sample; hosting performance is not guaranteed.' }, null, 2));
