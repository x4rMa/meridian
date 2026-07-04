/**
 * DAMM v2 screener range gate — verification test (Phase 2).
 *
 * Proves getRawPoolScreeningRejectReason enforces the downside_gap/upside_gap
 * floor for damm_v2 pools using the REST pool_price/min_price/max_price fields,
 * and that DLMM pools still go through the bin_step check unchanged.
 *
 * Run: node test/test-damm-screening.js
 */

import { getRawPoolScreeningRejectReason } from "../tools/screening.js";
import { config } from "../config.js";

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

function makePool(overrides) {
  return {
    pool_address: "PoolAddrAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "FAKE",
    tvl: 50000,
    active_tvl: 50000,
    fee_active_tvl_ratio: 0.2,
    volatility: 0.1,
    fee_24h: 100,
    fee: 10,
    volume: 5000,
    token_x: { address: "BaseMintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", organic_score: 90, warnings: [], market_cap: 200000, holders: 500 },
    token_y: { address: "So11111111111111111111111111111111111111112", organic_score: 90, warnings: [] },
    base_token_market_cap: 200000,
    base_token_holders: 500,
    base_token_organic_score: 90,
    quote_token_organic_score: 90,
    created_at: Date.now() - 10 * 86400000,
    ...overrides,
  };
}

function main() {
  console.log("=== DAMM v2 screener range gate — verification ===");
  const s = config.screening;
  // Conservative values so only the range/bin_step gates can fire.
  const sRelaxed = {
    ...s,
    minTvl: 10000, maxTvl: 1_000_000,
    minMcap: 1000, maxMcap: 100_000_000,
    minHolders: 1, minVolume: 1,
    minOrganic: 0, minQuoteOrganic: 0,
    minFeeActiveTvlRatio: 0,
    minBinStep: 80, maxBinStep: 125,
    dammMinDownsidePct: 15, dammMinUpsidePct: 15,
    excludeHighSupplyConcentration: false,
    minTokenAgeHours: null, maxTokenAgeHours: null,
  };

  // ── DAMM: downside_gap 6% < 15% → rejected by range gate ───────────────────
  const dammBadDownside = makePool({
    pool_type: "damm_v2",
    pool_price: 100, min_price: 94, max_price: 200, // downside 6%, upside 100%
  });
  const r1 = getRawPoolScreeningRejectReason(dammBadDownside, sRelaxed, "degen");
  console.log(`  [bad downside] reject: ${r1}`);
  assert(r1 != null && r1.includes("downside/upside risk bounds") && r1.includes("downside_gap 6.00%"), "DAMM pool with downside_gap=6% rejected by range gate");

  // ── DAMM: upside_gap 6% < 15% → rejected by range gate ─────────────────────
  const dammBadUpside = makePool({
    pool_type: "damm_v2",
    pool_price: 100, min_price: 50, max_price: 106, // downside 50%, upside 6%
  });
  const r2 = getRawPoolScreeningRejectReason(dammBadUpside, sRelaxed, "degen");
  console.log(`  [bad upside] reject: ${r2}`);
  assert(r2 != null && r2.includes("downside/upside risk bounds") && r2.includes("upside_gap 6.00%"), "DAMM pool with upside_gap=6% rejected by range gate");

  // ── DAMM: both gaps 30%/60% → passes the range gate ────────────────────────
  const dammOk = makePool({
    pool_type: "damm_v2",
    pool_price: 100, min_price: 70, max_price: 160, // downside 30%, upside 60%
  });
  const r3 = getRawPoolScreeningRejectReason(dammOk, sRelaxed, "degen");
  console.log(`  [ok damm] reject: ${r3}`);
  assert(r3 == null, "DAMM pool with both gaps >= 15% passes the range gate");

  // ── DAMM: missing price fields → rejected with explicit reason ──────────────
  const dammNoPrice = makePool({ pool_type: "damm_v2" /* no pool_price/min/max */ });
  const r4 = getRawPoolScreeningRejectReason(dammNoPrice, sRelaxed, "degen");
  console.log(`  [no price] reject: ${r4}`);
  assert(r4 != null && r4.includes("missing pool_price/min_price/max_price"), "DAMM pool missing price fields rejected");

  // ── DLMM: bin_step=100 (within 80-125) → passes; range gate never fires ─────
  const dlmmOk = makePool({
    pool_type: "dlmm",
    dlmm_params: { bin_step: 100 },
  });
  const r5 = getRawPoolScreeningRejectReason(dlmmOk, sRelaxed, "degen");
  console.log(`  [ok dlmm] reject: ${r5}`);
  assert(r5 == null, "DLMM pool with bin_step=100 passes the bin_step check (range gate not applied)");

  // ── DLMM: bin_step=50 (below 80) → rejected by bin_step check, not range ───
  const dlmmBadBin = makePool({
    pool_type: "dlmm",
    dlmm_params: { bin_step: 50 },
  });
  const r6 = getRawPoolScreeningRejectReason(dlmmBadBin, sRelaxed, "degen");
  console.log(`  [bad dlmm bin] reject: ${r6}`);
  assert(r6 != null && r6.includes("bin_step") && !r6.includes("downside/upside"), "DLMM pool with bin_step=50 rejected by bin_step check, NOT the DAMM range gate");

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) { console.error("FAIL: screener range gate misbehaved."); process.exit(1); }
  console.log("PASS: DAMM range gate rejects over-tight pools, admits valid ones, DLMM bin_step check unaffected.");
  process.exit(0);
}

main();
