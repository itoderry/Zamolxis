#!/usr/bin/env node
// Stock prediction GAME engine for Zamolxis's stock-game subagent. A paper-trading simulation:
// we "buy" at REAL live market prices, and later score every prediction against the REAL price it
// actually reached — so the track record is honest. No real money, no real orders are ever placed;
// this is a game / learning tool, NOT financial advice.
//
// Data: Yahoo Finance's public chart endpoint (keyless), with a Stooq CSV fallback. Runs locally.
// Ledger: %USERPROFILE%\.zamolxis\stockgame\ledger.json (pretend cash, open positions, closed
// predictions with real outcomes, cumulative stats, watchlist). Everything is machine-readable
// JSON on stdout so the agent can reason over it.
//
// Commands:
//   quote <T...>                          real price + indicators (SMA20/50, RSI14, 1m/3m momentum, vol) per ticker
//   history <T> [days]                    recent daily closes (for the agent to reason over)
//   buy <T> <shares> [--target x --stop x --horizon d --confidence 0-100 --dir up|down --why "..."]
//                                         open a pretend position at the CURRENT REAL price
//   sell <T|id>                           close a position now at the real price
//   portfolio                             mark all open positions to real price; equity, cash, P/L
//   evaluate                              close positions whose horizon elapsed or target/stop hit; score vs REAL price; update stats
//   track                                 the learning summary: win rate, avg return, calibration, best/worst
//   watchlist [add|remove|list] <T...>    manage the tickers the agent analyzes
//   reset [cash]                          reset the game (default 100000 pretend $)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.zamolxis', 'stockgame');
const LEDGER = path.join(DIR, 'ledger.json');
const START_CASH = 1000;
const now = () => new Date().toISOString();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

function load() {
  try { const l = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); if (!l.challengeDays) l.challengeDays = 30; if (!l.equityHistory) l.equityHistory = []; return l; }
  catch { return { cash: START_CASH, startCash: START_CASH, startedAt: now(), challengeDays: 30, positions: [], closed: [], equityHistory: [], watchlist: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN'] }; }
}
// Snapshot equity onto the 30-day curve, de-duped to ~2h so refreshes don't bloat it.
function snapshotEquity(l, equity) {
  l.equityHistory = l.equityHistory || [];
  const last = l.equityHistory[l.equityHistory.length - 1];
  if (!last || Date.now() - new Date(last.t).getTime() > 2 * 3600 * 1000) {
    l.equityHistory.push({ t: now(), e: round(equity) });
    if (l.equityHistory.length > 400) l.equityHistory = l.equityHistory.slice(-400);
    return true;
  }
  return false;
}
function save(l) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); }

// ---- real market data (keyless) ----
async function fetchChart(ticker, range = '6mo') {
  const t = String(ticker).trim().toUpperCase();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=${range}&interval=1d`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`data http ${r.status} for ${t}`);
  const d = await r.json();
  const res = d?.chart?.result?.[0];
  if (!res) throw new Error(`no data for ${t}`);
  const price = res.meta?.regularMarketPrice;
  const prevClose = res.meta?.chartPreviousClose ?? res.meta?.previousClose;
  const q = res.indicators?.quote?.[0] || {};
  const closes = (q.close || []).filter((x) => x != null);
  const highs = (q.high || []).filter((x) => x != null);
  const lows = (q.low || []).filter((x) => x != null);
  if (!Number.isFinite(price) && !closes.length) throw new Error(`empty data for ${t}`);
  const cur = Number.isFinite(price) ? price : closes[closes.length - 1];
  return { ticker: t, price: cur, prevClose, closes, highs, lows, currency: res.meta?.currency || 'USD', name: res.meta?.longName || res.meta?.shortName || t };
}

function sma(a, n) { if (a.length < n) return null; const s = a.slice(-n).reduce((x, y) => x + y, 0); return s / n; }
function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) { const ch = closes[i] - closes[i - 1]; if (ch >= 0) g += ch; else l -= ch; }
  const ag = g / n, al = l / n; if (al === 0) return 100; const rs = ag / al; return 100 - 100 / (1 + rs);
}
function momentum(closes, days) { if (closes.length < days + 1) return null; const past = closes[closes.length - 1 - days]; return past ? (closes[closes.length - 1] / past - 1) * 100 : null; }
function volatility(closes, n = 20) {
  if (closes.length < n + 1) return null;
  const rets = []; for (let i = closes.length - n; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length;
  return Math.sqrt(v) * Math.sqrt(252) * 100; // annualized %
}
function indicators(c) {
  return {
    sma20: round(sma(c, 20)), sma50: round(sma(c, 50)),
    rsi14: round(rsi(c, 14), 1),
    mom_1m: round(momentum(c, 21), 1), mom_3m: round(momentum(c, 63), 1),
    vol_annual_pct: round(volatility(c, 20), 1),
    high_6m: round(Math.max(...c)), low_6m: round(Math.min(...c)),
  };
}

async function priceOf(ticker) { const d = await fetchChart(ticker, '5d'); return d.price; }

// ---- position outcome scoring against REAL price ----
function scoreClose(p, exit, reason) {
  const dir = p.direction || 'up';
  const pnlPct = (exit / p.entry - 1) * 100 * (dir === 'down' ? -1 : 1); // "down" bets profit when price falls
  const rawPct = (exit / p.entry - 1) * 100;
  const pnlUsd = (exit - p.entry) * p.shares; // the paper account is always long the shares it "bought"
  const hitTarget = p.target ? (dir === 'down' ? exit <= p.target : exit >= p.target) : null;
  const win = pnlPct > 0;
  const days = Math.max(0, Math.round((Date.now() - new Date(p.entryDate).getTime()) / 86400000));
  return { ...p, exit: round(exit), exitDate: now(), closeReason: reason, rawReturnPct: round(rawPct), pnlPct: round(pnlPct), pnlUsd: round(pnlUsd), hitTarget, win, daysHeld: days };
}
function recomputeStats(l) {
  const c = l.closed;
  const wins = c.filter((x) => x.win);
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  l.stats = {
    predictions: c.length,
    wins: wins.length,
    win_rate_pct: round(c.length ? (wins.length / c.length) * 100 : 0, 1),
    avg_return_pct: round(avg(c.map((x) => x.pnlPct)), 2),
    avg_win_pct: round(avg(wins.map((x) => x.pnlPct)), 2),
    avg_loss_pct: round(avg(c.filter((x) => !x.win).map((x) => x.pnlPct)), 2),
    target_hit_rate_pct: round((() => { const wt = c.filter((x) => x.hitTarget != null); return wt.length ? (wt.filter((x) => x.hitTarget).length / wt.length) * 100 : 0; })(), 1),
    realized_pnl_usd: round(c.reduce((s, x) => s + (x.pnlUsd || 0), 0)),
    best: c.length ? c.reduce((a, b) => (b.pnlPct > a.pnlPct ? b : a)) : null,
    worst: c.length ? c.reduce((a, b) => (b.pnlPct < a.pnlPct ? b : a)) : null,
  };
  if (l.stats.best) l.stats.best = { ticker: l.stats.best.ticker, pnlPct: l.stats.best.pnlPct };
  if (l.stats.worst) l.stats.worst = { ticker: l.stats.worst.ticker, pnlPct: l.stats.worst.pnlPct };
  return l.stats;
}

// ---- commands ----
function arg(flags, name, def) { const i = flags.indexOf('--' + name); return i >= 0 && flags[i + 1] ? flags[i + 1] : def; }

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const l = load();
  try {
    if (cmd === 'quote') {
      const tickers = rest.filter((x) => !x.startsWith('--'));
      const list = tickers.length ? tickers : l.watchlist;
      const items = [];
      for (const t of list) {
        try { const d = await fetchChart(t, '6mo'); const c = d.closes; const dch = c.length >= 2 ? (c[c.length - 1] / c[c.length - 2] - 1) * 100 : null; items.push({ ticker: d.ticker, name: d.name, price: round(d.price), day_change_pct: round(dch, 2), ...indicators(d.closes) }); }
        catch (e) { items.push({ ticker: t.toUpperCase(), error: String(e.message || e) }); }
      }
      return out({ ok: true, asOf: now(), quotes: items });
    }
    if (cmd === 'history') {
      const t = rest[0]; const days = parseInt(rest[1] || '30', 10);
      const d = await fetchChart(t, '6mo');
      return out({ ok: true, ticker: d.ticker, closes: d.closes.slice(-days).map((x) => round(x)) });
    }
    if (cmd === 'buy') {
      const t = (rest[0] || '').toUpperCase(); const shares = parseFloat(rest[1]);
      if (!t || !(shares > 0)) return out({ ok: false, error: 'usage: buy <TICKER> <shares> [--target x --stop x --horizon d --confidence 0-100 --dir up|down --why "..."]' });
      const d = await fetchChart(t, '5d'); const entry = d.price;
      const cost = entry * shares;
      if (cost > l.cash) return out({ ok: false, error: `not enough pretend cash: need $${round(cost)}, have $${round(l.cash)}` });
      const pos = {
        id: `${t}-${Date.now()}`, ticker: t, shares, entry: round(entry), entryDate: now(),
        direction: arg(rest, 'dir', 'up'), target: arg(rest, 'target') ? round(parseFloat(arg(rest, 'target'))) : null,
        stop: arg(rest, 'stop') ? round(parseFloat(arg(rest, 'stop'))) : null,
        horizonDays: parseInt(arg(rest, 'horizon', '30'), 10), confidence: parseInt(arg(rest, 'confidence', '50'), 10),
        rationale: arg(rest, 'why', ''),
      };
      l.cash = round(l.cash - cost); l.positions.push(pos); save(l);
      return out({ ok: true, opened: pos, cash: l.cash });
    }
    if (cmd === 'sell') {
      const key = rest[0]; const i = l.positions.findIndex((p) => p.id === key || p.ticker === (key || '').toUpperCase());
      if (i < 0) return out({ ok: false, error: 'no such open position' });
      const p = l.positions[i]; const exit = await priceOf(p.ticker);
      const closed = scoreClose(p, exit, 'manual'); l.closed.push(closed); l.positions.splice(i, 1);
      l.cash = round(l.cash + exit * p.shares); recomputeStats(l); save(l);
      return out({ ok: true, closed, cash: l.cash });
    }
    if (cmd === 'portfolio' || cmd === 'report') {
      let equity = l.cash; const positions = [];
      for (const p of l.positions) {
        let cur = null; try { cur = await priceOf(p.ticker); } catch { /* keep null */ }
        const mv = cur != null ? cur * p.shares : p.entry * p.shares; equity += mv;
        const daysHeld = Math.round((Date.now() - new Date(p.entryDate).getTime()) / 86400000);
        positions.push({ ticker: p.ticker, shares: p.shares, entry: p.entry, price: round(cur), unreal_pct: cur != null ? round((cur / p.entry - 1) * 100, 2) : null, target: p.target, horizonDays: p.horizonDays, daysHeld, matured: daysHeld >= p.horizonDays, confidence: p.confidence, rationale: p.rationale });
      }
      if (snapshotEquity(l, equity)) save(l);
      const days = l.challengeDays || 30;
      const elapsed = Math.floor((Date.now() - new Date(l.startedAt).getTime()) / 86400000);
      return out({ ok: true, asOf: now(), cash: round(l.cash), equity: round(equity), total_return_pct: round((equity / l.startCash - 1) * 100, 2), start_cash: l.startCash, challenge_days: days, days_elapsed: elapsed, days_left: Math.max(0, days - elapsed), open_positions: positions, stats: l.stats || null, equity_history: (l.equityHistory || []).slice(-60).map((x) => [x.t, x.e]) });
    }
    if (cmd === 'evaluate') {
      const closedNow = [];
      for (let i = l.positions.length - 1; i >= 0; i--) {
        const p = l.positions[i];
        let cur; try { cur = await priceOf(p.ticker); } catch { continue; }
        const daysHeld = (Date.now() - new Date(p.entryDate).getTime()) / 86400000;
        const hitTarget = p.target && (p.direction === 'down' ? cur <= p.target : cur >= p.target);
        const hitStop = p.stop && (p.direction === 'down' ? cur >= p.stop : cur <= p.stop);
        const matured = daysHeld >= (p.horizonDays || 30);
        if (hitTarget || hitStop || matured) {
          const reason = hitTarget ? 'target' : hitStop ? 'stop' : 'horizon';
          const closed = scoreClose(p, cur, reason); l.closed.push(closed); l.positions.splice(i, 1);
          l.cash = round(l.cash + cur * p.shares); closedNow.push(closed);
        }
      }
      recomputeStats(l); save(l);
      return out({ ok: true, closed_now: closedNow, still_open: l.positions.length, stats: l.stats });
    }
    if (cmd === 'track') { recomputeStats(l); return out({ ok: true, since: l.startedAt, stats: l.stats, recent: l.closed.slice(-10).map((x) => ({ ticker: x.ticker, dir: x.direction, entry: x.entry, exit: x.exit, pnlPct: x.pnlPct, win: x.win, reason: x.closeReason, confidence: x.confidence })) }); }
    if (cmd === 'watchlist') {
      const sub = rest[0]; const ts = rest.slice(1).map((x) => x.toUpperCase());
      if (sub === 'add') l.watchlist = [...new Set([...l.watchlist, ...ts])];
      else if (sub === 'remove') l.watchlist = l.watchlist.filter((x) => !ts.includes(x));
      if (sub === 'add' || sub === 'remove') save(l);
      return out({ ok: true, watchlist: l.watchlist });
    }
    if (cmd === 'reset') { const cash = parseFloat(rest[0]) || START_CASH; const days = parseInt(rest[1], 10) || 30; save({ cash, startCash: cash, startedAt: now(), challengeDays: days, positions: [], closed: [], equityHistory: [], watchlist: l.watchlist }); return out({ ok: true, reset: true, cash, challengeDays: days }); }
    return out({ ok: false, error: `unknown command "${cmd || ''}". Try: quote | history | buy | sell | portfolio | evaluate | track | watchlist | reset` });
  } catch (err) { return out({ ok: false, error: String(err.message || err) }); }
}
main();
