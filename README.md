# Pump.fun Paper Sprint: Any Bot Can Win — Launch Sniper

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/hackedbyexteam-debug/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/hackedbyexteam-debug/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the make.fun pump.fun replay sprint. It replays 6
hours of real pump.fun bonding-curve events and ranks by net PnL.

## Strategy

Launch sniper: buy coins within 0–3 slots of their `CreateEvent`, but only
when the opening tape passes a rug filter — the creator bought a small real
amount (0.05–1 SOL) and has not sold, only 1–6 other wallets bought in,
sells have not overwhelmed buys, no single sell is large against the real
SOL reserve, the price has not already run away, and recent flow is
positive. One buy per coin (up to 0.3 SOL, capped at 1% of the real SOL
reserve).

Exits: stop loss −12%, first take-profit +25% (bank half), trailing stop,
fade in flow, whale sell, creator sell, 300-slot time limit — unless the
curve is near bonding completion, in which case the runner rides. Tiny probe
round trips keep the guardrail pace (≥20 coins with ≥0.01 SOL round trips).

## Layout

- `main.ts` — the replay client: NDJSON `agent-fun/replay/v2` on
  stdin/stdout, keeps curves, cash, positions and pending orders.
- `strategy.ts` — the sniper: rug filter, exits, pacing probes.

Deterministic: no clock, no network, no randomness — two runs over the same
data emit identical replies.

## Grade locally

```sh
node cli/makefun.mjs grade-local --kit . --bot . --driver process
```
