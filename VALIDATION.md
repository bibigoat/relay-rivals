# Local verification

Verified on 2026-11-04 with Node.js 24.22.1 on Windows. This is local evidence, not sponsor acceptance or a hosted-service guarantee.

## Automated checks

`node --test test/*.test.mjs`: 19 passed, 0 failed. Coverage includes 2–4-player completion and rotating initiative, ties and spotlight scoring, decay, legal moves, energy limits, immutable snapshots, version conflicts, simultaneous duplicate writes, host authorization, credential redaction, timeout moves, complete HTTP replay, and a separately launched sample bot playing a full game through HTTP.

The adaptive built-in bot defeats a simple surge/charge policy in two recorded two-player seat orders (32–25 and 25–23). Search does not mutate the live board. This is a counterexample to that particular simple policy's dominance, not proof that the game is balanced.

## Browser checks

Created a room through the interface, joined it from a second browser tab, launched the match, selected a relay, submitted a player action, observed synchronized scores and timeout moves, reloaded with the seat preserved, moved the replay slider to the starting state, and downloaded valid replay JSON without credential fields.

An initial missing heading ID prevented complete rendering; it was corrected and the flow was rerun. No new console errors were recorded during the corrected flow. The browser check used the desktop viewport. Responsive CSS is present; phone-device testing has not been performed.

## Limits

Fun remains a human play-test question. A deterministic comparison of five simple policies over 200 ordered 2–4-seat games still showed the surge/charge policy was strong in three/four-player games. Broad competitive balance and the task's no-dominant-strategy criterion remain unverified.

The game is intentionally a single-process, temporary-room demo. It has no persistent database, anti-abuse service or uptime guarantee. Server-side limits cap rooms and request sizes; socket-based rate limits may aggregate users behind a hosting proxy. Public deployment, external-network multiplayer, container build and sponsor judging are pending.
