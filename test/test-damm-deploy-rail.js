/**
 * DAMM v2 deploy safety rail — verification test (Phase 2).
 *
 * Phase 2 replaces the Phase-1 hard block with a config-gated range-verification
 * gate. Three behaviors must hold:
 *  1. enableDammDeploy=false (default) → every damm_v2 deploy is blocked with
 *     a "disabled" reason, before any on-chain tx. (Operator must opt in.)
 *  2. enableDammDeploy=true + a DAMM pool whose fixed range violates the
 *     requested downside_pct/upside_pct → blocked with a "Live pool range
 *     violates" reason.
 *  3. A DLMM pool is never blocked by the DAMM gate (regression).
 *
 * Strategy: stub global.fetch so fetchFreshPoolDetail returns synthetic pool
 * details, then call executeTool with the DAMM pool address. Assert the blocked
 * responses. No DAMM_PROGRAM_ID import is used — the gate reads detail.pool_type
 * + pool_price/min_price/max_price only.
 *
 * Run: node test/test-damm-deploy-rail.js
 */

import { executeTool } from "../tools/executor.js";
import { config } from "../config.js";

// Synthetic DAMM v2 pool. pool_price/min_price/max_price drive the range gate.
// Range here: price=100, min=92, max=108 → downside_gap=8%, upside_gap=8%.
// Requesting downside_pct=20/upside_pct=20 must therefore be rejected.
const DAMM_POOL_DETAIL = {
  pool_address: "DAMMPOOLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  pool_type: "damm_v2",
  name: "FAKE/DAMM",
  tvl: 100000,
  active_tvl: 100000,
  fee_active_tvl_ratio: 0.5,
  volatility: 0.1,
  fee_24h: 50,
  fee: 5,
  dlmm_params: { bin_step: 100 }, // ignored for DAMM (null-guarded)
  pool_price: 100,
  min_price: 92,
  max_price: 108,
};

const DLMM_POOL_DETAIL = {
  pool_address: "DLMMPOOLbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  pool_type: "dlmm",
  name: "FAKE/DLMM",
  tvl: 100000,
  active_tvl: 100000,
  fee_active_tvl_ratio: 0.5,
  volatility: 0.1,
  fee_24h: 50,
  fee: 5,
  dlmm_params: { bin_step: 100 },
};

function makeFetchStub(detailByPool) {
  return async (url) => {
    const target = Object.keys(detailByPool).find((addr) => url.includes(addr));
    const detail = target ? detailByPool[target] : null;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: detail ? [detail] : [] }),
    };
  };
}

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

async function testDammDisabledByDefault() {
  console.log("\n[Test 1] deploy_position against DAMM v2 with enableDammDeploy=false must be blocked");
  const original = config.management.enableDammDeploy;
  const originalFetch = global.fetch;
  config.management.enableDammDeploy = false;
  global.fetch = makeFetchStub({ [DAMM_POOL_DETAIL.pool_address]: DAMM_POOL_DETAIL });
  try {
    const result = await executeTool("deploy_position", {
      pool_address: DAMM_POOL_DETAIL.pool_address,
      pool_type: "damm_v2",
      amount_y: 0.05,
      downside_pct: 20,
      upside_pct: 20,
    });
    assert(result && result.blocked === true, `returns { blocked: true } (got: ${JSON.stringify(result).slice(0, 120)})`);
    assert(
      typeof result?.reason === "string" && result.reason.includes("enableDammDeploy=false"),
      `reason mentions the disabled flag (got: ${result?.reason})`
    );
    assert(!result?.tx && !result?.txs && !result?.position, "no tx/txs/position field (no on-chain action)");
  } finally {
    config.management.enableDammDeploy = original;
    global.fetch = originalFetch;
  }
}

async function testDammRangeViolation() {
  console.log("\n[Test 2] deploy_position against DAMM v2 with flag on + range violation must be blocked");
  const original = config.management.enableDammDeploy;
  const originalFetch = global.fetch;
  config.management.enableDammDeploy = true;
  global.fetch = makeFetchStub({ [DAMM_POOL_DETAIL.pool_address]: DAMM_POOL_DETAIL });
  try {
    const result = await executeTool("deploy_position", {
      pool_address: DAMM_POOL_DETAIL.pool_address,
      pool_type: "damm_v2",
      amount_y: 0.05,
      downside_pct: 20, // pool only covers 8% → must be rejected
      upside_pct: 20,
    });
    assert(result && result.blocked === true, `returns { blocked: true } (got: ${JSON.stringify(result).slice(0, 120)})`);
    assert(
      typeof result?.reason === "string" && result.reason.includes("Live pool range violates requested downside/upside bounds"),
      `reason mentions range violation (got: ${result?.reason})`
    );
    assert(!result?.tx && !result?.txs && !result?.position, "no tx/txs/position field (no on-chain action)");
  } finally {
    config.management.enableDammDeploy = original;
    global.fetch = originalFetch;
  }
}

async function testDlmmNotBlockedByDammGate() {
  console.log("\n[Test 3] deploy_position against a DLMM pool must NOT be blocked by the DAMM gate");
  const original = config.management.enableDammDeploy;
  const originalFetch = global.fetch;
  config.management.enableDammDeploy = false; // even with the flag off, DLMM must not hit the DAMM gate
  global.fetch = makeFetchStub({ [DLMM_POOL_DETAIL.pool_address]: DLMM_POOL_DETAIL });
  try {
    const result = await executeTool("deploy_position", {
      pool_address: DLMM_POOL_DETAIL.pool_address,
      pool_type: "dlmm",
      amount_y: 0.05,
      bins_below: 40,
    });
    const blockedByDammGate =
      result?.blocked === true &&
      typeof result?.reason === "string" &&
      (result.reason.includes("enableDammDeploy") || result.reason.includes("Live pool range violates"));
    assert(!blockedByDammGate, `DLMM pool is NOT blocked by the DAMM gate (got: ${JSON.stringify(result).slice(0, 120)})`);
  } finally {
    config.management.enableDammDeploy = original;
    global.fetch = originalFetch;
  }
}

async function main() {
  console.log("=== DAMM v2 deploy safety rail — Phase 2 verification ===");
  await testDammDisabledByDefault();
  await testDammRangeViolation();
  await testDlmmNotBlockedByDammGate();
  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.error("FAIL: safety rail did not behave as required.");
    process.exit(1);
  }
  console.log("PASS: safety rail blocks DAMM deploys correctly under both gate states, DLMM unaffected.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});
