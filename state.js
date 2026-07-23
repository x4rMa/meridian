/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const STATE_FILE = repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    // Backward-compat migration: existing state.json positions predate the
    // pool_type field (DLMM-only era). Patch every loaded position to 'dlmm'
    // if the field is absent, so the manager cycle and reports always see a
    // populated pool_type. This runs in-memory on every load — never throws,
    // never mutates disk (a subsequent save() will persist it, which is fine).
    if (state && state.positions) {
      for (const posId in state.positions) {
        const pos = state.positions[posId];
        if (pos && !pos.pool_type) pos.pool_type = "dlmm";
        // Tri-state migration: backfill state_status + chain_confirmed_closed.
        // Legacy `closed:true` positions were verified by closePosition's
        // confirmation loop before recordClose, so they are authoritative.
        if (pos && pos.state_status == null) {
          if (pos.closed) {
            pos.state_status = "closed";
            pos.chain_confirmed_closed = true;
          } else {
            pos.state_status = "open";
            pos.chain_confirmed_closed = false;
          }
          pos.state_status_since = pos.closed_at || pos.deployed_at || new Date().toISOString();
        }
        // Monotonicity assertion: state_status=closed without chain confirmation
        // is corruption. Auto-fix + log so it's visible.
        if (pos && pos.state_status === "closed" && !pos.chain_confirmed_closed) {
          log("lifecycle", `lifecycle_fatal: ${posId} state_status=closed but chain_confirmed_closed=false — auto-fixing`);
          pos.chain_confirmed_closed = true;
        }
        if (pos && pos.state_status === "closed" && !pos.closed) {
          pos.closed = true;
        }
      }
    }
    return state;
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

/**
 * A position is "closed for sure" only when chain confirmation landed.
 * This is the ONE gate that disables risk management. A mere `closed` flag
 * (possibly stale from a false syncOpenPositions) never suppresses exits.
 * chain_confirmed_closed is a sticky one-way ratchet: once true, never reset.
 */
export function isClosedConfirmed(pos) {
  return !!(pos && pos.chain_confirmed_closed);
}

/**
 * Transition a position's state_status, stamping state_status_since and emitting
 * a lifecycle log. Monotonic guard: CLOSED→OPEN is forbidden (would indicate
 * corruption or a resurrected-then-reconfirmed position). `force` bypasses the
 * guard — used only by an explicit recovery command (none yet exists).
 */
function transitionStatus(pos, newStatus, { force = false } = {}) {
  const prev = pos.state_status;
  if (prev === newStatus) return false;
  if (prev === "closed" && newStatus !== "closed" && !force) {
    log("lifecycle", `lifecycle_fatal: refusing CLOSED→${newStatus} for ${pos.position} (monotonic). Use force=true for explicit recovery.`);
    return false;
  }
  pos.state_status = newStatus;
  pos.state_status_since = new Date().toISOString();
  if (newStatus === "closed") {
    pos.chain_confirmed_closed = true; // sticky ratchet
    pos.last_chain_confirmation = pos.state_status_since;
    pos.closed = true;
  } else {
    pos.closed = false;
  }
  log("lifecycle", `${prev}→${newStatus} ${pos.position?.slice(0, 8)}`);
  return true;
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
  pool_type = "dlmm",
  tier = null,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    signal_snapshot: signal_snapshot || null,
    pool_type,
    tier,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    oor_chase_count: 0,
    closed: false,
    closed_at: null,
    state_status: "open",
    chain_confirmed_closed: false,
    state_status_since: new Date().toISOString(),
    last_chain_confirmation: null,
    closure_unconfirmed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_peak_started_at: null,
    pending_exit_action: null,
    pending_exit_count: 0,
    pending_exit_started_at: null,
    trailing_active: false,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new ${pool_type} position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    // Store time-to-OOR once so analyze-performance can correlate it with deploy-time
    // signals (price_change_1h, volume_acceleration, volatility) without recomputing.
    if (pos.deployed_at) {
      const mins = (Date.now() - new Date(pos.deployed_at).getTime()) / 60000;
      pos.time_to_oor_minutes = Math.round(mins * 100) / 100;
    }
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * Bump the OOR-chase counter on a position (how many times we've redeployed
 * a new position to chase the price after this one went out-of-range fast).
 * Capped at config.management.maxOorChasesPerPool by the caller; this helper
 * just increments and returns the new count.
 */
export function incrementOorChase(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return 0;
  pos.oor_chase_count = (pos.oor_chase_count ?? 0) + 1;
  save(state);
  log("state", `Position ${position_address} OOR chase count -> ${pos.oor_chase_count}`);
  return pos.oor_chase_count;
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed_at = new Date().toISOString();
  transitionStatus(pos, "closed");
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

/**
 * Set a per-position hold window that exempts LOW_YIELD (and deterministic
 * Rule 5) from closing the position until the timestamp passes. Used when an
 * operator has advance knowledge of a near-term catalyst (e.g. "pumps in ~3h")
 * and needs to prevent the low-yield rule from closing a thin-fee position
 * before the surge. Stop-loss, trailing TP, OOR, and take-profit remain
 * fully active — this exempts yield-based closes only.
 * @param {string} position_address
 * @param {number} hours - hold duration in hours; <= 0 clears the hold.
 * @returns {{ saved: boolean, hold_until: string|null }}
 */
export function setPositionHoldUntil(position_address, hours) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return { saved: false, hold_until: null };
  if (!Number.isFinite(hours) || hours <= 0) {
    pos.hold_until = null;
    save(state);
    log("state", `Position ${position_address} hold_until cleared`);
    return { saved: true, hold_until: null };
  }
  const expiry = new Date(Date.now() + hours * 3600_000);
  pos.hold_until = expiry.toISOString();
  save(state);
  log("state", `Position ${position_address} hold_until set to ${pos.hold_until} (${hours}h)`);
  return { saved: true, hold_until: pos.hold_until };
}

/**
 * Whether a position's LOW_YIELD exemption is currently active (hold_until
 * exists and hasn't expired). Expired holds are ignored, not mutated — the
 * timestamp stays as an audit trail; the time comparison is what expires it.
 * @param {object} pos - a state.json position object (must have .hold_until)
 */
export function isHoldUntilActive(pos) {
  if (!pos || !pos.hold_until) return false;
  const expiry = new Date(pos.hold_until).getTime();
  if (!Number.isFinite(expiry)) return false;
  return Date.now() < expiry;
}

// Stamp the exit-indicator-gate result on the position so the close path's
// recordPerformance call can attribute the close (or veto) to the gate that
// was consulted. Persisted because the gate runs in executeManagementActions
// (in-memory) but the perf record is built later in dlmm.js from state.json.
export function setPositionIndicatorExitCheck(position_address, check) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.indicator_exit_check = check ?? null;
  save(state);
  return true;
}

// Stamp the canonical exit reason (STOP_LOSS, TRAILING_TP, OUT_OF_RANGE, etc.)
// on the position so analyze-performance can bucket by a stable enum rather
// than the templated close_reason string. Persisted for the same reason as
// indicator_exit_check — stamped in executeManagementActions, read in dlmm.js.
export function setPositionExitReason(position_address, exitReason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.exit_reason = exitReason ?? null;
  save(state);
  return true;
}

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive polls where the
 * candidate stays above the current peak. With the 3s RPC poller this confirms a real
 * high in ~3-6s and prevents a single noisy tick from inflating the peak (which would
 * otherwise arm a false trailing-drop). Replaces the old 15s setTimeout recheck.
 * Returns true when the peak was raised this call.
 */
export function confirmPeak(position_address, candidatePnlPct, confirmTicks = 2) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || isClosedConfirmed(pos)) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  // No new high — drop any pending peak candidate.
  if (candidatePnlPct <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      save(state);
    }
    return false;
  }

  // Same-or-higher candidate as the pending one → another confirming tick.
  if (pos.pending_peak_pnl_pct != null && candidatePnlPct >= pos.pending_peak_pnl_pct) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidatePnlPct;
  } else {
    // New / lower-than-pending candidate → start a fresh confirmation streak.
    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_confirm_count = 1;
    pos.pending_peak_started_at = new Date().toISOString();
  }

  if (pos.pending_peak_confirm_count >= confirmTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, pos.pending_peak_pnl_pct);
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% (${confirmTicks} ticks)`);
    return true;
  }

  save(state);
  return false;
}

/**
 * Consecutive-tick confirmation for an exit signal. The fast poller calls this every
 * tick with the exit action string detected this poll (or null when no exit). An exit
 * only fires after `confirmTicks` consecutive polls report the SAME action — so a single
 * noisy tick can't close a position. Streak resets whenever the signal clears or changes.
 * Returns { fire, action, count }.
 */
export function registerExitSignal(position_address, signal, confirmTicks = 2) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || isClosedConfirmed(pos)) return { fire: false, action: null, count: 0 };

  if (!signal) {
    if (pos.pending_exit_action != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos.pending_exit_action === signal) {
    pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
    pos.pending_exit_started_at = new Date().toISOString();
  }

  const count = pos.pending_exit_count;
  const fire = count >= confirmTicks;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
    pos.pending_exit_started_at = null;
  }
  save(state);
  if (fire) log("state", `Position ${position_address} exit signal "${signal}" confirmed (${confirmTicks} ticks)`);
  return { fire, action: signal, count };
}

/**
 * Get all tracked positions (optionally filter open-only).
 * "open" here includes UNKNOWN (unconfirmed-closed) positions — they occupy
 * capital and may still be active on-chain, so they count against capacity and
 * keep the PnL poller running. Only chain-confirmed CLOSED (closed=true)
 * positions are excluded.
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      pool_type: p.pool_type || "dlmm",
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
      hold_until: p.hold_until || null,
      state_status: p.state_status || "open",
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || isClosedConfirmed(pos)) return null;

  // Observability: when exits are evaluated on an UNKNOWN (unconfirmed-closed)
  // position, surface it once per unknown-status period. This is the exact
  // scenario that caused the TrumpCoin incident — exits kept being silently
  // skipped on a stale `closed` flag. With tri-state, UNKNOWN positions are
  // actively managed; this log confirms that.
  if (pos.state_status === "unknown" && !pos._exitLoggedForUnknown) {
    log("lifecycle", `EXIT_EVALUATED_ON_UNKNOWN ${position_address.slice(0, 8)} pnl=${currentPnlPct}%`);
    pos._exitLoggedForUnknown = true;
    save(state);
  } else if (pos.state_status !== "unknown" && pos._exitLoggedForUnknown) {
    pos._exitLoggedForUnknown = false;
    save(state);
  }

  let changed = false;

  // ── Post-deploy early-return sampling (OOR-predictor instrumentation) ────────
  // Capture pnl_pct at the 5/15/30-min marks + the max pnl in the first 15 min.
  // Rides the existing 3s poller tick — last-write-wins within each window so the
  // recorded value is the one closest to the boundary. Pure measurement: never
  // affects exit logic. Skipped on suspicious ticks to avoid poisoning the sample.
  if (!pnl_pct_suspicious && Number.isFinite(currentPnlPct) && pos.deployed_at) {
    const minutesSinceDeploy = (Date.now() - new Date(pos.deployed_at).getTime()) / 60000;
    if (minutesSinceDeploy <= 5) {
      pos.first_5m_return_pct = Math.round(currentPnlPct * 100) / 100;
      changed = true;
    }
    if (minutesSinceDeploy <= 15) {
      pos.first_15m_return_pct = Math.round(currentPnlPct * 100) / 100;
      if (currentPnlPct > (pos.max_pnl_pct_first_15m ?? -Infinity)) {
        pos.max_pnl_pct_first_15m = Math.round(currentPnlPct * 100) / 100;
      }
      changed = true;
    }
    if (minutesSinceDeploy <= 30) {
      pos.first_30m_return_pct = Math.round(currentPnlPct * 100) / 100;
      changed = true;
    }
  }

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    if (pos.deployed_at) {
      const mins = (Date.now() - new Date(pos.deployed_at).getTime()) / 60000;
      pos.time_to_oor_minutes = Math.round(mins * 100) / 100;
    }
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  // Skipped while a per-position hold_until exemption is active — that window
  // is set by an operator with near-term catalyst knowledge and intentionally
  // prevents LOW_YIELD from closing a thin-fee position before the surge.
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck) &&
    !isHoldUntilActive(pos)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 *
 * Tri-state model — SDK absence is NOT closure:
 *   OPEN    → (SDK missing, grace expired) → UNKNOWN
 *   UNKNOWN → (getAccountInfo confirms gone) → CLOSED (chain_confirmed_closed=true, sticky)
 *   UNKNOWN → (getAccountInfo still exists) → OPEN (SDK false negative, recovered)
 *
 * `confirmClosed(positionAddress)` is an async callback (supplied by dlmm.js, which
 * owns the Solana connection) returning true if the position account is gone on-chain.
 * state.js stays free of web3.js. If the callback throws or RPC fails, it must return
 * false — we never confirm-closed on an RPC error (would risk a false closure).
 *
 * If the account still exists → OPEN (SDK blip). log CLOSE_CONFIRMATION_FAILED so SDK
 * indexing lag is directly measurable.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't even go UNKNOWN for positions deployed < 5 min ago

export async function syncOpenPositions(active_addresses, confirmClosed) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    // Chain-confirmed closed → done forever (monotonic).
    if (isClosedConfirmed(pos)) continue;
    // Seen by SDK this cycle → (re)confirm OPEN, clear any pending unknown.
    if (activeSet.has(posId)) {
      if (pos.state_status === "unknown") {
        transitionStatus(pos, "open");
        pos.closure_unconfirmed_at = null;
        changed = true;
      }
      continue;
    }

    // Grace period: newly deployed positions may not be indexed yet.
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping`);
      continue;
    }

    // SDK didn't return it.
    if (pos.state_status === "open") {
      // First miss → UNKNOWN. Do NOT touch closed/chain_confirmed_closed.
      transitionStatus(pos, "unknown");
      pos.closure_unconfirmed_at = new Date().toISOString();
      changed = true;
      log("state", `Position ${posId} → UNKNOWN (SDK missing, grace expired)`);
      continue;
    }

    if (pos.state_status === "unknown") {
      // Second+ miss → confirm against chain before closing.
      let confirmed = false;
      if (typeof confirmClosed === "function") {
        try {
          confirmed = await confirmClosed(posId);
        } catch (e) {
          log("state", `confirmClosed RPC failed for ${posId}: ${e.message} — staying UNKNOWN`);
          confirmed = false;
        }
      }
      if (confirmed) {
        pos.closed_at = new Date().toISOString();
        const dur = pos.closure_unconfirmed_at
          ? Date.now() - new Date(pos.closure_unconfirmed_at).getTime()
          : null;
        transitionStatus(pos, "closed");
        pos.closure_unconfirmed_at = null;
        pos.notes.push(`Closed at ${pos.closed_at}: confirmed missing on-chain (getAccountInfo)`);
        changed = true;
        log("lifecycle", `UNKNOWN→CLOSED ${posId.slice(0, 8)} (confirmed via getAccountInfo)${dur != null ? ` UNKNOWN_DURATION_MS=${dur}` : ""}`);
      } else {
        // Account still exists → SDK false negative. Recover to OPEN.
        const dur = pos.closure_unconfirmed_at
          ? Date.now() - new Date(pos.closure_unconfirmed_at).getTime()
          : null;
        transitionStatus(pos, "open");
        pos.closure_unconfirmed_at = null;
        changed = true;
        log("lifecycle", `UNKNOWN→OPEN ${posId.slice(0, 8)} (recovered — account still on-chain)${dur != null ? ` UNKNOWN_DURATION_MS=${dur}` : ""}`);
        log("lifecycle", `CLOSE_CONFIRMATION_FAILED ${posId.slice(0, 8)} (SDK false negative — account exists but SDK missed it)`);
      }
      continue;
    }
  }

  if (changed) save(state);
}
