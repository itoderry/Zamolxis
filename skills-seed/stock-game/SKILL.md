---
name: stock-game
description: A stock-prediction GAME — analyze stocks with real market data, "buy" on paper at the real price, then over time score each prediction against the REAL price it actually reached, track a win rate, and learn from past calls to improve future ones. Simulation only, no real money or orders. Backs the stock-game subagent. Use when the user asks to run the stock game, make predictions, check the portfolio / track record, or evaluate past picks.
---

# Stock Prediction Game

A paper-trading learning game. Uses **real market data** (Yahoo Finance, keyless) and scores every
call against the **real** price it actually reached — so the track record is honest. It **pretends**
to buy with play money (default $100,000). **No real money and no real orders are ever involved —
this is a game / learning tool, not financial advice.**

## The engine (`stockgame.mjs`)

A local Node script (no dependencies, no API key). All output is JSON. Ledger lives in
`%USERPROFILE%\.zamolxis\stockgame\ledger.json` (pretend cash, open positions, closed predictions
with their real outcomes, cumulative stats, watchlist).

- `quote <T...>` — real price, day change, and indicators (SMA20/50, RSI14, 1-month & 3-month
  momentum, annualized volatility, 6-month high/low) for each ticker (defaults to the watchlist).
- `history <T> [days]` — recent daily closes to reason over.
- `buy <T> <shares> [--target x --stop x --horizon d --confidence 0-100 --dir up|down --why "…"]`
  — opens a pretend position at the **current real price**, records the prediction (direction,
  target, horizon, confidence, rationale) and deducts play cash.
- `portfolio` — marks every open position to the **real** current price: equity, cash, unrealized P/L.
- `evaluate` — closes any position whose horizon elapsed or whose target/stop was hit, at the **real**
  price, scores it (win/loss, % return, target hit?), and updates the cumulative stats. This is the
  honest "did the prediction come true?" step.
- `track` — the learning summary: number of predictions, win rate, average return, target-hit rate,
  best/worst, and the last 10 outcomes.
- `watchlist add|remove|list <T...>` — manage the tickers analyzed. `reset [cash]` — start over.

## How the subagent plays (each run)

1. `evaluate` — settle any matured predictions against the real price; note wins/losses.
2. `portfolio` + `track` — current standing and the running win rate.
3. Read its own **working memory** for lessons from past runs (what patterns it's been right/wrong on).
4. `quote <watchlist>` — fresh real prices + indicators.
5. Analyze and, informed by its track record, make a few new predictions with a rationale, target,
   horizon (days) and confidence — then record them with `buy`.
6. Save a short lesson to memory (e.g. "over-optimistic on high-RSI momentum names").
7. Report clearly: matured results (win/loss + P/L), portfolio equity vs the $100k start, the win
   rate, and today's new picks with reasoning — always noting it's a simulation, not advice.

## Learning

"Learning" here = the agent reviews its **real** hit rate and P/L (from `track`) plus its own working
notes before each new set of predictions, and adjusts (position sizing, which signals it trusts,
confidence calibration). The scoreboard is honest because entries and outcomes both use real prices.

## Not financial advice

This is a game to practice and measure predictions. It never places real orders, holds no money, and
its picks are not recommendations. Do not trade real money based on it.
