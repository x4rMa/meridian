/**
 * DAMM v2 close/claim dispatch — verification test (Phase 2).
 *
 * Proves closePosition / claimFees (in tools/dlmm.js) dispatch to the DAMM
 * implementations when the tracked position's pool_type === 'damm_v2', and
 * stay on the DLMM path otherwise. Uses DRY_RUN=true so no RPC is needed; the
 * DAMM dry_run returns carry a `pool_type: "damm_v2"` marker that proves which
 * branch fired. The DLMM dry_run returns do NOT carry that marker.
 *
 * Strategy: back up the real state.json, seed two tracked positions (one DLMM,
 * one DAMM), call the functions directly, assert the marker, restore state.json.
 *
 * Run: node test/test-damm-close-claim.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, "..", "state.json");
const BACKUP_FILE = STATE_FILE + ".bak.damm-test";

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

async function main() {
  console.log("=== DAMM v2 close/claim dispatch — Phase 2 verification ===");

  // ── Back up the real state.json so we don't clobber the operator's state. ──
  const hadState = fs.existsSync(STATE_FILE);
  if (hadState) fs.copyFileSync(STATE_FILE, BACKUP_FILE);

  // ── Set DRY_RUN so both paths short-circuit before any RPC. ────────────────
  process.env.DRY_RUN = "true";

  // Lazy imports AFTER env is set, so modules pick up DRY_RUN.
  const { trackPosition, recordClose } = await import("../state.js");
  const { closePosition, claimFees } = await import("../tools/dlmm.js");

  const DLMM_POS = "DlmmPosaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const DAMM_POS = "DammPosbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const DLMM_POOL = "DlmmPoolaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const DAMM_POOL = "DammPoolbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  try {
    // ── Seed two tracked positions: one DLMM, one DAMM v2. ───────────────────
    trackPosition({
      position: DLMM_POS, pool: DLMM_POOL, pool_name: "FAKE/DLMM",
      strategy: "bid_ask", amount_sol: 0.5, active_bin: 100, bin_step: 100,
      pool_type: "dlmm",
    });
    trackPosition({
      position: DAMM_POS, pool: DAMM_POOL, pool_name: "FAKE/DAMM",
      strategy: "damm_v2_spot", amount_sol: 0.5, pool_type: "damm_v2",
    });

    // ── Close: DAMM position must route to the DAMM branch. ──────────────────
    console.log("\n[Test 1] closePosition dispatches a damm_v2-tracked position to the DAMM path");
    {
      const result = await closePosition({ position_address: DAMM_POS, reason: "test" });
      console.log(`  [damm close] result: ${JSON.stringify(result)}`);
      assert(result?.dry_run === true, "DAMM close returns dry_run: true (no RPC in DRY_RUN)");
      assert(result?.pool_type === "damm_v2", `DAMM close return carries pool_type:'damm_v2' marker — proves DAMM branch fired (got: ${result?.pool_type})`);
      assert(result?.would_close === DAMM_POS, "would_close echoes the DAMM position address");
    }

    // ── Close: DLMM position must NOT carry the DAMM marker (regression). ────
    console.log("\n[Test 2] closePosition keeps a dlmm-tracked position on the DLMM path");
    {
      const result = await closePosition({ position_address: DLMM_POS, reason: "test" });
      console.log(`  [dlmm close] result: ${JSON.stringify(result)}`);
      assert(result?.dry_run === true, "DLMM close returns dry_run: true");
      assert(result?.pool_type !== "damm_v2", `DLMM close does NOT carry the damm_v2 marker — proves it stayed on DLMM path (got: ${result?.pool_type})`);
    }

    // ── Claim: DAMM position must route to the DAMM branch. ──────────────────
    console.log("\n[Test 3] claimFees dispatches a damm_v2-tracked position to the DAMM path");
    {
      const result = await claimFees({ position_address: DAMM_POS });
      console.log(`  [damm claim] result: ${JSON.stringify(result)}`);
      assert(result?.dry_run === true, "DAMM claim returns dry_run: true (no RPC in DRY_RUN)");
      assert(result?.pool_type === "damm_v2", `DAMM claim return carries pool_type:'damm_v2' marker — proves DAMM branch fired (got: ${result?.pool_type})`);
      assert(result?.would_claim === DAMM_POS, "would_claim echoes the DAMM position address");
    }

    // ── Claim: DLMM position must NOT carry the DAMM marker (regression). ────
    console.log("\n[Test 4] claimFees keeps a dlmm-tracked position on the DLMM path");
    {
      const result = await claimFees({ position_address: DLMM_POS });
      console.log(`  [dlmm claim] result: ${JSON.stringify(result)}`);
      assert(result?.dry_run === true, "DLMM claim returns dry_run: true");
      assert(result?.pool_type !== "damm_v2", `DLMM claim does NOT carry the damm_v2 marker — proves it stayed on DLMM path (got: ${result?.pool_type})`);
    }

    // ── Dispatch by tracked pool_type, not by an LLM-supplied field. ─────────
    // close_position / claim_fees take no pool_type arg; they read the tracked
    // position. Confirm a DAMM position whose tracked pool_type is damm_v2
    // dispatches correctly even though we never pass pool_type in the call.
    console.log("\n[Test 5] close dispatch keys off tracked pool_type, not a call-time arg");
    {
      const result = await closePosition({ position_address: DAMM_POS });
      assert(result?.pool_type === "damm_v2", "DAMM dispatch fires with no pool_type in the close call (reads tracked state)");
    }
  } finally {
    // ── Restore the operator's real state.json. ──────────────────────────────
    if (hadState) {
      fs.copyFileSync(BACKUP_FILE, STATE_FILE);
      fs.unlinkSync(BACKUP_FILE);
      console.log("\n(restored real state.json from backup)");
    } else if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
      console.log("\n(removed test-only state.json — none existed before)");
    }
  }

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) { console.error("FAIL: close/claim dispatch misbehaved."); process.exit(1); }
  console.log("PASS: close/claim route damm_v2-tracked positions to the DAMM path; DLMM positions unaffected.");
  process.exit(0);
}

main().catch((e) => {
  // Best-effort restore on unexpected error.
  try { if (fs.existsSync(BACKUP_FILE)) { fs.copyFileSync(BACKUP_FILE, STATE_FILE); fs.unlinkSync(BACKUP_FILE); } } catch {}
  console.error("Test harness error:", e);
  process.exit(1);
});
