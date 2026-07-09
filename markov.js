/**
 * Markov chain price-state analysis.
 *
 * Builds per-pool transition matrices from closed-position history (stored in
 * pool-memory.json deploys[]). Classifies each close into one of 5 discrete
 * price-trend states, then computes a 5×5 row-normalized transition matrix with
 * per-row entropy. The predicted next state + confidence feed the SCREENER
 * (deprioritize high-entropy pools) and MANAGER (trailing-TP / close decisions).
 *
 * The matrix is re-derived from deploys[] on every read — no incremental drift,
 * automatically PM2-restart-safe. The persisted markov_matrix field in
 * pool-memory.json is a cache, not a source of truth.
 *
 * Non-blocking: every function returns null on insufficient/missing data so
 * callers fall back to existing heuristics.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";

const POOL_MEMORY_FILE = repoPath("pool-memory.json");

export const STATES = ["DOWNTREND", "STABLE", "UPTREND", "PUMPED_OOR", "DRIFTED_OOR"];
const STATE_INDEX = Object.fromEntries(STATES.map((s, i) => [s, i]));
const MIN_DEPLOYS = 3;

function loadPoolMemory() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePoolMemory(db) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(db, null, 2));
}

/**
 * Classify a closed-position record into a discrete price-trend state.
 * Uses pnl_pct and close_reason — no new API calls.
 *
 * @param {Object} perf - { pnl_pct, close_reason }
 * @returns {string} one of STATES
 */
export function classifyState(perf) {
  if (!perf) return "STABLE";
  const reason = String(perf.close_reason || "").toLowerCase();
  const pnl = Number.isFinite(perf.pnl_pct) ? perf.pnl_pct : 0;

  if (reason.includes("stop loss") || pnl <= -5) return "DOWNTREND";
  if (reason.includes("pumped far above range") || reason.includes("pumped")) return "PUMPED_OOR";
  if (reason.includes("out of range") || reason === "oor") return "DRIFTED_OOR";
  if (reason.includes("take profit") || reason.includes("trailing")) {
    return pnl >= 5 ? "UPTREND" : "STABLE";
  }
  if (pnl >= 5) return "UPTREND";
  return "STABLE";
}

/**
 * Build the 5×5 transition matrix for a pool from its deploys[] history.
 * Each consecutive pair of closes forms one transition observation.
 *
 * @param {string} poolAddress
 * @returns {Object|null} { states, counts, probabilities, entropy, totalTransitions,
 *                          current_state, predicted_next, confidence, last_close_reason } or null
 */
export function calculateTransitionMatrix(poolAddress) {
  if (!poolAddress) return null;
  const db = loadPoolMemory();
  const entry = db[poolAddress];
  if (!entry?.deploys || entry.deploys.length < MIN_DEPLOYS) return null;

  const deploys = entry.deploys;
  const states = deploys.map(classifyState);

  // Build count matrix
  const counts = STATES.map(() => STATES.map(() => 0));
  for (let i = 1; i < states.length; i++) {
    const from = STATE_INDEX[states[i - 1]];
    const to = STATE_INDEX[states[i]];
    if (from != null && to != null) counts[from][to]++;
  }

  const totalTransitions = states.length - 1;
  if (totalTransitions < MIN_DEPLOYS - 1) return null;

  // Row-normalize → probabilities
  const probabilities = counts.map((row) => {
    const sum = row.reduce((s, v) => s + v, 0);
    return sum > 0 ? row.map((v) => v / sum) : STATES.map(() => 0);
  });

  // Shannon entropy per row (in bits), normalized to [0,1] by log2(5)
  const maxEntropy = Math.log2(STATES.length);
  const entropy = probabilities.map((row) => {
    const sum = row.reduce((s, v) => s + v, 0);
    if (sum === 0) return 1; // unknown row = maximally uncertain
    const h = row.reduce((s, p) => (p > 0 ? s - p * Math.log2(p) : s), 0);
    return maxEntropy > 0 ? h / maxEntropy : 0;
  });

  // Current state = last classified close
  const currentState = states[states.length - 1];
  const currentIdx = STATE_INDEX[currentState];

  // Predicted next state = highest-probability transition from current state
  const row = probabilities[currentIdx];
  let bestState = "STABLE";
  let bestProb = 0;
  for (let i = 0; i < row.length; i++) {
    if (row[i] > bestProb) {
      bestProb = row[i];
      bestState = STATES[i];
    }
  }

  const result = {
    states: STATES,
    counts,
    probabilities,
    entropy,
    totalTransitions,
    sample_count: deploys.length,
    current_state: currentState,
    predicted_next: bestProb > 0 ? bestState : null,
    confidence: Math.round(bestProb * 100),
    last_close_reason: deploys[deploys.length - 1]?.close_reason || null,
    pool_name: entry.name || poolAddress.slice(0, 8),
  };

  // Persist the cached matrix
  try {
    if (!entry.markov_matrix) entry.markov_matrix = null;
    entry.markov_matrix = {
      totalTransitions,
      sample_count: deploys.length,
      current_state: currentState,
      predicted_next: result.predicted_next,
      confidence: result.confidence,
      avg_entropy: Math.round((entropy.reduce((s, e) => s + e, 0) / entropy.length) * 100) / 100,
      updated_at: new Date().toISOString(),
    };
    savePoolMemory(db);
  } catch (e) {
    log("markov", `Failed to persist matrix cache for ${poolAddress.slice(0, 8)}: ${e.message}`);
  }

  return result;
}

/**
 * Record a transition observation after a position closes.
 * Called from lessons.js recordPerformance() after recordPoolDeploy.
 * Re-derives the full matrix from deploys[] (self-correcting, no drift).
 *
 * @param {string} poolAddress
 * @param {Object} perf - the performance entry ({ pnl_pct, close_reason })
 */
export function recordTransition(poolAddress, perf) {
  if (!poolAddress) return;
  try {
    const matrix = calculateTransitionMatrix(poolAddress);
    if (matrix) {
      log("markov", `Transition recorded for ${matrix.pool_name}: ${matrix.totalTransitions} transitions, current=${matrix.current_state}, predicted=${matrix.predicted_next} (${matrix.confidence}%)`);
    }
  } catch (e) {
    log("markov", `recordTransition failed for ${poolAddress.slice(0, 8)}: ${e.message}`);
  }
}

/**
 * Predict the next state for a pool.
 * Thin wrapper around calculateTransitionMatrix.
 *
 * @param {string} poolAddress
 * @returns {Object|null} { predicted_next, confidence, current_state } or null
 */
export function predictNextState(poolAddress) {
  const m = calculateTransitionMatrix(poolAddress);
  if (!m) return null;
  return {
    predicted_next: m.predicted_next,
    confidence: m.confidence,
    current_state: m.current_state,
    totalTransitions: m.totalTransitions,
  };
}

/**
 * Build a compact prompt-injection string for open positions.
 * Joins state.json positions → their pool → matrix.
 * Returns null if no open position has sufficient history (suppressed from prompt).
 *
 * @returns {string|null}
 */
export function getMarkovSummary() {
  if (!config.markov?.enabled) return null;
  let state;
  try {
    const stateDb = JSON.parse(fs.readFileSync(repoPath("state.json"), "utf8"));
    state = stateDb;
  } catch {
    return null;
  }
  const positions = Object.values(state?.positions || {}).filter((p) => !p.closed);
  if (positions.length === 0) return null;

  const lines = [];
  for (const pos of positions) {
    const matrix = calculateTransitionMatrix(pos.pool);
    if (!matrix) continue;
    const entropy = matrix.entropy[STATES.indexOf(matrix.current_state)] ?? 0;
    const entropyPct = Math.round(entropy * 100);
    const pred = matrix.predicted_next
      ? `→ ${matrix.predicted_next} (${matrix.confidence}%)`
      : "→ unknown";
    lines.push(
      `${matrix.pool_name}: state=${matrix.current_state} ${pred}, volatility=${entropyPct}% (${matrix.totalTransitions} transitions)`
    );
  }

  if (lines.length === 0) return null;
  return lines.join("\n");
}

/**
 * Tool handler: get_markov_state
 * Returns the full transition matrix + prediction for a single pool.
 *
 * @param {Object} args
 * @param {string} args.pool_address
 * @returns {Object}
 */
export function getMarkovState({ pool_address } = {}) {
  if (!pool_address) return { error: "pool_address required" };

  const matrix = calculateTransitionMatrix(pool_address);
  if (!matrix) {
    return {
      pool_address,
      available: false,
      message: `Insufficient history — need ${MIN_DEPLOYS}+ closed deploys to build a transition matrix.`,
    };
  }

  return {
    pool_address,
    available: true,
    pool_name: matrix.pool_name,
    current_state: matrix.current_state,
    predicted_next: matrix.predicted_next,
    confidence: matrix.confidence,
    total_transitions: matrix.totalTransitions,
    sample_count: matrix.sample_count,
    last_close_reason: matrix.last_close_reason,
    transition_probabilities: STATES.reduce((acc, state, i) => {
      acc[state] = STATES.reduce((row, s, j) => {
        row[s] = Math.round(matrix.probabilities[i][j] * 100) / 100;
        return row;
      }, {});
      return acc;
    }, {}),
    entropy: STATES.reduce((acc, s, i) => {
      acc[s] = Math.round(matrix.entropy[i] * 100) / 100;
      return acc;
    }, {}),
  };
}
