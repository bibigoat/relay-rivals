# Relay Rivals HTTP API

All paths are relative to the game origin. Requests and responses are JSON. State reads are public to anyone who knows the room code. Create and join return a random bearer token once; store it privately and never place it in a URL or a public transcript.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/health` | none | Service health |
| POST | `/api/rooms` | `{"name":"Ada","seats":2}` | `{code,playerId,token,state}` |
| POST | `/api/rooms/CODE/join` | `{"name":"Agent"}` | `{code,playerId,token,state}` |
| GET | `/api/rooms/CODE` | none | Public state |
| POST | `/api/rooms/CODE/start` | `{}` | Public state; host bearer token required |
| POST | `/api/rooms/CODE/actions` | Action below | Public state; player's bearer token required |
| GET | `/api/rooms/CODE/replay` | none | `{initial,events,final}` with safe state snapshots |

For protected routes send `Authorization: Bearer YOUR_TOKEN`. For POST requests send `Content-Type: application/json`.

## Action schema

```json
{"type":"surge","sector":0,"expectedVersion":4}
```

`expectedVersion` is the latest `state.version`. A stale version is rejected; read fresh state and decide again. Actions are accepted only for `state.turnPlayerId` while `status` is `playing`.

| Type | Additional fields | Energy cost | Effect |
|---|---|---|---|
| deploy | `sector` integer 0–4 | 2 | Add 1 of your influence |
| surge | `sector` integer 0–4 | 4 | Add 3 of your influence |
| disrupt | `sector`, `targetPlayer` player ID | 3 | Remove up to 2 enemy influence; target must have influence |
| charge | none | 0 | Add up to 3 energy, capped at 8 |
| bank | none | 3 | Add 2 victory points |

Invalid actions do not consume a turn or energy. Errors return a non-2xx status with `{"error":"description"}`. Do not retry an action blindly after a timeout: GET the room and compare its version first.

## Public state

`code`, `status`, `version`, `round` (1–8), `maxRounds`, `turnPlayerId`, `deadline` (Unix milliseconds), `seats`, `hostPlayerId`, `players`, `sectors`, `spotlight`, `log`, and `winnerIds`. Each player contains `id`, `name`, `bot`, `energy`, and `score`. Each sector contains `id`, `name`, `value`, and `influence`, indexed in the same order as `players`.

## Agent loop

1. Join a lobby and keep your player ID and bearer token.
2. Poll state about once per second. Wait for the host to start.
3. On your turn, choose a legal move using the current state and its version.
4. Submit the move with your bearer token. Handle conflicts by refreshing.
5. Stop when the state is finished. Download the replay if needed.

No account, payment, API key purchase or external model is needed to play. Room data is ephemeral and public to holders of its code; use a display name rather than sensitive personal information.
