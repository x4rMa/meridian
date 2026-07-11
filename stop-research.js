// Stop-research instrumentation — observes positions near the stop threshold
// and records tick-level data needed to calibrate a future confirmation window.
//
// This module is PURE OBSERVATION. It never influences whether a position
// closes. It writes append-only JSONL to logs/stop-research.jsonl.
//
// What it records and why:
//
// 1. TICK events — every poll tick while a position's pnl_pct is inside the
//    observation band (default [-12%, -4%]). Carries elapsed-time accumulators
//    (seconds_below_-7, seconds_below_-10) so we can later ask:
//    "of positions that dwelt below -7% for N seconds, what fraction recovered?"
//    Elapsed time is the state variable the consecutive-tick proxy stands in
//    for; it degrades gracefully under oscillation (-7.1,-6.9,-7.2,...)
//    where a pure consecutive-count never fires.
//
// 2. TRIGGER events — when a STOP_LOSS actually fires. Schedules a
//    counterfactual fetch of the same position's pnl_pct at +3/+6/+9/+15/+30s
//    AFTER the trigger, without affecting execution. This directly answers:
//    "would waiting one more poll have helped?" — the highest-value statistic
//    given the tiny sample size (4 stops this week).
//
// 3. CLOSE events — final outcome: actual pnl_pct at close, fees earned,
//    minutes held, close_reason. Joins TICK/TRIGGER by position_id.
//
// All timestamps are real ISO strings (the poller runs in the main process,
// so wall-clock is available). All file I/O is append-only fs.appendFileSync
// — no load/save cycle, no in-memory cache, no throws into the caller.

import fs from "fs";
import path from "path";
import { repoPath } from "./repo-root.js";

const LOG_FILE = repoPath("logs", "stop-research.jsonl");

// Observation band: record ticks while pnl_pct is within [LOW, HIGH].
// The stop sits at -7%; we bracket it so we see both the approach and the
// recovery. Tunable via config.stopResearch if needed later.
const BAND_LOW = -12;   // record down to -12% (catches the -10% hard-tier regime too)
const BAND_HIGH = -4;    // record once a position is within 3% of the stop

// Thresholds for dwell-time accumulation. Mirror the production stop (-7%)
// and the candidate hard tier (-10%). Keep as constants so the analysis
// script can read them from the file header.
export const DWELL_THRESHOLDS = [-7, -10];

// Per-position in-memory dwell accumulator. Keyed by position address.
// We deliberately do NOT persist this across restarts: if the process
// restarts mid-dwell, elapsed time resets — acceptable, since a restart
// gap is itself a confound we'd rather drop than fake.
const _dwell = new Map(); // position_address -> { first_below_ts, last_ts, sec_below: { [-7]: n, [-10]: n }, peak, worst }

function ensureDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function append(record) {
  try {
    ensureDir();
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n");
  } catch (e) {
    // Never let logging throw into the poller / close path.
    // Swallow is correct here: this is observation, not risk logic.
  }
}

function nowSec(tsIso) {
  return Date.parse(tsIso) / 1000;
}

/**
 * Record a poll tick for a position if it's inside the observation band.
 * Accumulates per-position dwell time below each DWELL_THRESHOLDS value.
 *
 * @param {object} p — the poll position object from getMyPositions
 *   (carries: position, pool, pair, pnl_pct, unclaimed_fees_usd,
 *    total_value_usd, active_bin, lower_bin, upper_bin, age_minutes, fee_per_tvl_24h)
 * @param {number|null} peakPnlPct — pos.peak_pnl_pct from state (best PnL seen)
 */
export function logTick(p, peakPnlPct) {
  try {
    if (!p?.position || p.pnl_pct == null) return;
    const pnl = p.pnl_pct;
    if (pnl > BAND_HIGH || pnl < BAND_LOW) {
      // Outside the band: if we were tracking dwell for this position, close
      // it out (the position recovered above -4% or collapsed below -12%).
      if (_dwell.has(p.position)) _dwell.delete(p.position);
      return;
    }

    const tsIso = new Date().toISOString();
    const ts = nowSec(tsIso);

    let d = _dwell.get(p.position);
    if (!d) {
      d = {
        first_below_ts: ts,
        last_ts: ts,
        last_pnl: pnl,
        sec_below: {},
        peak: peakPnlPct ?? pnl,
        worst: pnl,
      };
      _dwell.set(p.position, d);
    }

    // Accumulate elapsed time below each threshold since the last tick.
    // Attribution uses the PREVIOUS tick's pnl: the gap between ticks is time
    // the position spent at the previous reading, so we count it against the
    // thresholds the previous reading satisfied. This avoids undercounting
    // dwell on recovery ticks (e.g. prev=-7.5%, this=-6.9%: the ~3s at -7.5%
    // must count toward sec_below_-7, but a current-reading check would miss it).
    // On the first tick dt is 0 (we just entered), so no attribution is needed.
    const prevPnl = d.last_pnl;
    const dt = d.last_ts ? Math.max(0, ts - d.last_ts) : 0;
    if (dt > 0 && prevPnl != null) {
      for (const thr of DWELL_THRESHOLDS) {
        if (prevPnl <= thr) d.sec_below[thr] = (d.sec_below[thr] ?? 0) + dt;
      }
    }
    d.last_ts = ts;
    d.last_pnl = pnl;
    if (peakPnlPct != null && peakPnlPct > d.peak) d.peak = peakPnlPct;
    if (pnl < d.worst) d.worst = pnl;

    append({
      kind: "TICK",
      ts: tsIso,
      position_id: p.position,
      pool: p.pool,
      pair: p.pair,
      pnl_pct: pnl,
      peak_pnl_pct: d.peak,
      worst_pnl_pct: d.worst,
      sec_below_minus_7: Number((d.sec_below[-7] ?? 0).toFixed(2)),
      sec_below_minus_10: Number((d.sec_below[-10] ?? 0).toFixed(2)),
      unclaimed_fees_usd: p.unclaimed_fees_usd,
      total_value_usd: p.total_value_usd,
      fee_per_tvl_24h: p.fee_per_tvl_24h,
      active_bin: p.active_bin,
      lower_bin: p.lower_bin,
      upper_bin: p.upper_bin,
      in_range: p.in_range,
      age_minutes: p.age_minutes,
    });
  } catch {
    // swallow — observation must never break the poller
  }
}

/**
 * Record that a STOP_LOSS fired. Schedules counterfactual pnl_pct fetches at
 * +3/+6/+9/+15/+30s to answer "would waiting have helped?" WITHOUT affecting
 * execution. The fetcher callback is injected so this module stays free of
 * SDK imports and unit-testable.
 *
 * @param {object} p — the poll position object at trigger time
 * @param {string} reason — the exit reason string
 * @param {function} fetcher — async (position_address) => pnl_pct|null, called on schedule
 */
export function logTrigger(p, reason, fetcher) {
  try {
    if (!p?.position) return;
    const tsIso = new Date().toISOString();
    const d = _dwell.get(p.position);

    const triggerRecord = {
      kind: "TRIGGER",
      ts: tsIso,
      position_id: p.position,
      pool: p.pool,
      pair: p.pair,
      pnl_pct_at_trigger: p.pnl_pct,
      reason,
      sec_below_minus_7_at_trigger: d ? Number((d.sec_below[-7] ?? 0).toFixed(2)) : null,
      sec_below_minus_10_at_trigger: d ? Number((d.sec_below[-10] ?? 0).toFixed(2)) : null,
      worst_pnl_pct_seen: d ? d.worst : p.pnl_pct,
      unclaimed_fees_usd: p.unclaimed_fees_usd,
      total_value_usd: p.total_value_usd,
      age_minutes: p.age_minutes,
      counterfactual: {}, // filled by scheduled fetches below
    };
    append(triggerRecord);

    // Schedule counterfactual fetches. These run in the main process; the
    // fetcher should be the same cheap RPC path getMyPositions uses (force:false
    // is fine — we want the freshest readable value, not a deploy-grade fetch).
    const delays = [3, 6, 9, 15, 30];
    const posId = p.position;
    for (const delay of delays) {
      setTimeout(async () => {
        try {
          const pnl = await fetcher(posId);
          append({
            kind: "COUNTERFACTUAL",
            trigger_ts: tsIso,
            position_id: posId,
            pair: p.pair,
            seconds_after_trigger: delay,
            pnl_pct: pnl,
            // null pnl means the position was already closed by then (expected
            // at +30s for a fast close) — itself useful signal.
          });
        } catch {
          // swallow
        }
      }, delay * 1000);
    }
  } catch {
    // swallow
  }
}

/**
 * Record the final outcome of a position close (stop or otherwise).
 * Joins to TICK/TRIGGER streams by position_id.
 *
 * @param {object} p — the poll position object at close, OR a synthetic with
 *   at least { position, pool, pair, pnl_pct, pnl_usd, unclaimed_fees_usd,
 *   collected_fees_usd, minutes_held, close_reason }
 * @param {string} closeReason
 */
export function logClose(p, closeReason) {
  try {
    if (!p?.position) return;
    const d = _dwell.get(p.position);
    append({
      kind: "CLOSE",
      ts: new Date().toISOString(),
      position_id: p.position,
      pool: p.pool,
      pair: p.pair,
      pnl_pct: p.pnl_pct,
      pnl_usd: p.pnl_usd,
      unclaimed_fees_usd: p.unclaimed_fees_usd,
      collected_fees_usd: p.collected_fees_usd,
      minutes_held: p.minutes_held,
      close_reason: closeReason,
      total_sec_below_minus_7: d ? Number((d.sec_below[-7] ?? 0).toFixed(2)) : null,
      total_sec_below_minus_10: d ? Number((d.sec_below[-10] ?? 0).toFixed(2)) : null,
      worst_pnl_pct_seen: d ? d.worst : null,
    });
    _dwell.delete(p.position);
  } catch {
    // swallow
  }
}

/**
 * Drop a position from the in-memory dwell tracker (e.g. on close that
 * didn't go through logClose, or on stale cleanup). Safe to call with
 * unknown id.
 */
export function forget(position_address) {
  _dwell.delete(position_address);
}
