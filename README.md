# Relay Rivals

A short, open-information strategy game for humans and HTTP agents at the same table. Two to four players, eight rounds, five contested relays. No player accounts, dependencies, paid APIs, or external assets.

## Rules in one paragraph

Score the most points over eight rounds. Each player takes one action per round: deploy one influence for 2 energy, surge three influence for 4, disrupt two enemy influence for 3, charge up to 3 energy, or bank 2 points for 3 energy. At the end of the round, each relay's sole influence leader scores its printed value; the spotlight relay scores 2 extra points, and ties score nothing. All influence then decays by one and every player gains 2 energy, capped at 8. The spotlight and first player rotate, so holding a relay, contesting a rival, and saving energy have different value each round. Highest score wins; equal top scores share the win. A missed 15-second turn is played automatically, keeping a four-player match within eight minutes of scheduled turns under normal server operation.

## Run

Requires Node.js 22 or newer. No install step is needed.

```sh
node server.mjs
```

Open the local URL printed by the server. Create a room, share its eight-character code, and start when everyone has joined. Empty seats become bots. Player credentials live in that browser tab's session storage; do not share them. The same tab can reconnect after a reload. A new tab or cleared storage cannot recover a seat.

```sh
node --test test/*.test.mjs
```

The server defaults to loopback for local use. For hosting, set `HOST=0.0.0.0`; `PORT` defaults to 3000 and the host may override it.

## Agents

Agents use the same rules, authorization, deadlines and version checks as human players. There is no privileged bot endpoint. Start the sample bot after creating a lobby and before starting the match:

```sh
node sample-bot.mjs --url http://127.0.0.1:3000 --room ROOMCODE --name SampleBot
```

See [API.md](API.md) or the browser's `/api.html` page. The built-in bot and sample bot use local heuristics, not a remote language model. The game can also be played by an independently implemented AI through the API.

## Replay

The interface shows a match log and lets you review recorded states or download replay JSON. `GET /api/rooms/CODE/replay` returns the initial state, accepted actions and safe state snapshots. Public snapshots exclude bearer tokens. Replay downloads are your durable copy; room state on the server is temporary.

## Hosting

`render.yaml` defines one free Node web service, and `Dockerfile` supports a conventional container host. On Render, use the Node runtime, `node --check server.mjs` as the build command, `node server.mjs` as the start command, `HOST=0.0.0.0`, and `/api/health` as the health check path. Select the Free instance type.

This is a small single-process demo. Rooms are stored in memory, expire after two hours without activity, and disappear on process restart. Run one instance only. Render's free tier can sleep after 15 minutes idle and take about a minute to wake; it can also restart. Do not promise persistent match history or an availability SLA. Download the replay after a match.

## Scope and provenance

Created for Taskmarket task **TSK-JKVSTHB7**. Code, interface and game rules were produced with AI assistance and verified locally. No sponsor endorsement, acceptance or income is claimed. The task has a subjective fun/play-test criterion; automated checks cannot prove that a game is fun or that no dominant strategy exists.

No analytics or third-party requests are required by the game.

## License

Released under the [MIT License](LICENSE).
