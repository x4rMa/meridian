/**
 * DAMM v2 (Meteora cp-amm) SDK wrapper — READ-ONLY Phase 1.
 *
 * Provides visibility into DAMM v2 positions: fetch via cpAmm.getPositionsByUser,
 * compute in_range from the POOL's sqrtPrice vs sqrtMinPrice/sqrtMaxPrice (DAMM
 * positions do not carry their own range — see PoolState), and surface unclaimed
 * fees. PnL % and fee_per_tvl_24h are NOT available in Phase 1 (no deposit-
 * history API for DAMM); positions return pnl_pct=null, pnl_pct_suspicious=true,
 * which makes the manager's PnL-gated exit rules (STOP_LOSS, TRAILING_TP) skip
 * them. OOR is still tracked via in_range.
 *
 * All on-chain reads go through getPnlConnection() (the same public RPC the DLMM
 * poller uses) so the main RPC budget is untouched.
 *
 * OOR-timer caveat: markInRange/markOutOfRange early-return for positions not
 * yet in state.json, and minutesOutOfRange returns 0 for them. So a DAMM
 * position created out-of-band (e.g. via the Meteora UI) will report
 * in_range=false in /positions and Telegram, but the deterministic OUT_OF_RANGE
 * auto-close timer won't start until the position is tracked. Phase 1 is
 * read-only, so we do not auto-track; positions deployed by Meridian (Phase 2+)
 * will be tracked at deploy time and the timer will work.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { getPnlConnection } from "./pnl.js";
import {
  markInRange,
  markOutOfRange,
  minutesOutOfRange,
  getTrackedPosition,
  trackPosition,
  recordClose,
  recordClaim,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { appendDecision } from "../decision-log.js";
import { getWalletBalances } from "./wallet.js";
import { config, computeDeployAmount } from "../config.js";

// ─── Lazy SDK loader (mirrors tools/dlmm.js:38-75) ────────────────────────────
// cp-amm-sdk → @coral-xyz/anchor uses the same CJS dir imports that break ESM
// on Node 24. Dynamic import defers loading until an actual on-chain call is
// needed. CpAmm is a NAMED export (verified), not the default.
let _CpAmm = null;
let _getUnClaimLpFee = null;
let _getTokenDecimals = null;
let _getPriceFromSqrtPrice = null;
let _getSqrtPriceFromPrice = null;
let _convertToLamports = null;
let _getTokenProgram = null;
let _getCurrentPoint = null;
let _derivePositionAddress = null;
let _deriveTokenVaultAddress = null;
let _derivePositionNftAccount = null;
let _CP_AMM_PROGRAM_ID = null;

async function getCpAmm() {
  if (!_CpAmm) {
    const mod = await import("@meteora-ag/cp-amm-sdk");
    _CpAmm = mod.CpAmm;
    _getUnClaimLpFee = mod.getUnClaimLpFee;
    _getTokenDecimals = mod.getTokenDecimals;
    _getPriceFromSqrtPrice = mod.getPriceFromSqrtPrice;
    _getSqrtPriceFromPrice = mod.getSqrtPriceFromPrice;
    _convertToLamports = mod.convertToLamports;
    _getTokenProgram = mod.getTokenProgram;
    _getCurrentPoint = mod.getCurrentPoint;
    _derivePositionAddress = mod.derivePositionAddress;
    _deriveTokenVaultAddress = mod.deriveTokenVaultAddress;
    _derivePositionNftAccount = mod.derivePositionNftAccount;
    _CP_AMM_PROGRAM_ID = mod.CP_AMM_PROGRAM_ID;
  }
  return {
    CpAmm: _CpAmm,
    getUnClaimLpFee: _getUnClaimLpFee,
    getTokenDecimals: _getTokenDecimals,
    getPriceFromSqrtPrice: _getPriceFromSqrtPrice,
    getSqrtPriceFromPrice: _getSqrtPriceFromPrice,
    convertToLamports: _convertToLamports,
    getTokenProgram: _getTokenProgram,
    getCurrentPoint: _getCurrentPoint,
    derivePositionAddress: _derivePositionAddress,
    deriveTokenVaultAddress: _deriveTokenVaultAddress,
    derivePositionNftAccount: _derivePositionNftAccount,
    CP_AMM_PROGRAM_ID: _CP_AMM_PROGRAM_ID,
  };
}

// ─── Wallet (mirrors tools/dlmm.js:82-100) ───────────────────────────────────
// Private here too — dlmm.js's getWallet is not exported. Same base58 decode.
let _wallet = null;
function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `DAMM wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

// DAMM deploys use the main RPC (process.env.RPC_URL), not the public PnL RPC —
// the PnL connection is read-only and rejects write transactions.
function getConnection() {
  return new Connection(process.env.RPC_URL, "confirmed");
}

export const DAMM_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, decimals) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : null;
}

// BN → number (lamports/raw). Use for sqrt-price math only when a numeric
// comparison is needed; price display uses the SDK's Decimal helper.
function bnToNum(bn) {
  if (bn == null) return 0;
  try {
    return Number(bn.toString());
  } catch {
    return 0;
  }
}

// Fetch USD prices for a set of mints from Jupiter datapi. Returns {mint: usd}.
// Reimplemented locally rather than importing pnl.js's getJupiterPrices (not
// exported) — same endpoint, same shape.
const JUP_PRICE = "https://price.jup.ag/v6";
async function getJupiterUsdPrices(mints) {
  const list = [...new Set(mints.map((m) => String(m || "").trim()).filter(Boolean))];
  if (!list.length) return {};
  try {
    const url = `${JUP_PRICE}/price?ids=${encodeURIComponent(list.join(","))}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Jupiter price ${res.status}`);
    const data = await res.json();
    const out = {};
    if (data && typeof data === "object") {
      // v6 returns { [mint]: { usdPrice } } or { data: { [mint]: { price } } }
      const src = data.data && typeof data.data === "object" ? data.data : data;
      for (const [mint, v] of Object.entries(src)) {
        const p = v?.usdPrice ?? v?.price ?? v;
        if (Number.isFinite(Number(p))) out[mint] = Number(p);
      }
    }
    return out;
  } catch (e) {
    log("damm_price", `Jupiter price fetch failed: ${e.message}`);
    return {};
  }
}

// ─── Fetch all pool states for a set of pool addresses (deduped) ──────────────
// DAMM positions share a pool's range, so we fetch each unique PoolState once
// and reuse it across every position in that pool.
async function fetchPoolStates(cpAmm, poolAddresses) {
  const unique = [...new Set(poolAddresses.filter(Boolean))];
  const byPool = {};
  await Promise.all(unique.map(async (addr) => {
    try {
      byPool[addr] = await cpAmm.fetchPoolState(new PublicKey(addr));
    } catch (e) {
      log("damm_pool", `fetchPoolState ${addr.slice(0, 8)} failed: ${e.message}`);
      byPool[addr] = null;
    }
  }));
  return byPool;
}

// Fetch on-chain decimals for each unique mint (deduped). One getTokenDecimals
// RPC per mint; failures default to 0 so the fee USD value drops to 0 rather
// than NaN. We can't assume 9 for SOL and 6 for USDC — DAMM pools can quote
// either token as A or B with arbitrary mints.
async function fetchMintDecimals(getTokenDecimals, conn, mints) {
  const unique = [...new Set(mints.filter(Boolean))];
  const byMint = {};
  await Promise.all(unique.map(async (mint) => {
    try {
      byMint[mint] = await getTokenDecimals(conn, new PublicKey(mint));
    } catch (e) {
      log("damm_decimals", `getTokenDecimals ${mint.slice(0, 8)} failed: ${e.message}`);
      byMint[mint] = 0;
    }
  }));
  return byMint;
}

// Raw BN token amount → USD. Scales by 10^decimals, then multiplies by spot.
function tokenAmountToUsd(rawAmount, decimals, usdPrice) {
  const raw = bnToNum(rawAmount);
  if (!raw || decimals == null || usdPrice == null) return 0;
  const human = raw / Math.pow(10, decimals);
  return safeNum(human) * safeNum(usdPrice);
}

// ─── Main entry: fetch a wallet's DAMM positions as the unified Position shape ──
// Returns the same field list as pnl.js buildPosition / dlmm.js getMyPositions,
// with bin fields null and pool_type: 'damm_v2'. Throws on SDK/RPC failure —
// the caller (tools/dlmm.js) wraps this in try/catch to degrade gracefully.
export async function getCpAmmPositions({ wallet_address, solMode = false } = {}) {
  const wallet = String(wallet_address || "").trim();
  if (!wallet) return [];

  const { CpAmm, getUnClaimLpFee, getTokenDecimals } = await getCpAmm();
  const conn = getPnlConnection();
  const cpAmm = new CpAmm(conn);

  // 1. Fetch all positions for this wallet (one SDK call).
  const userPositions = await cpAmm.getPositionsByUser(new PublicKey(wallet));
  if (!Array.isArray(userPositions) || userPositions.length === 0) return [];

  // 2. Deduplicate pool addresses — DAMM positions do NOT carry their own
  //    range; in_range is determined by the POOL's sqrtPrice vs the pool's
  //    sqrtMinPrice/sqrtMaxPrice. Fetch each unique PoolState once.
  const poolAddresses = userPositions
    .map((u) => u?.positionState?.pool?.toString?.())
    .filter(Boolean);
  const poolStatesByAddr = await fetchPoolStates(cpAmm, poolAddresses);

  // 3. Gather unique token mints across all pools and fetch decimals + USD
  //    prices once each (deduped). Fees are returned in raw token units
  //    (lamports for 9-dec SOL), so we need decimals to convert to USD.
  const mintSet = new Set();
  for (const addr of Object.keys(poolStatesByAddr)) {
    const ps = poolStatesByAddr[addr];
    if (!ps) continue;
    if (ps.tokenAMint) mintSet.add(ps.tokenAMint.toString());
    if (ps.tokenBMint) mintSet.add(ps.tokenBMint.toString());
  }
  const mintList = [...mintSet];
  const [usdByMint, decimalsByMint] = await Promise.all([
    getJupiterUsdPrices(mintList),
    fetchMintDecimals(getTokenDecimals, conn, mintList),
  ]);

  // 4. Build a unified Position object per DAMM position.
  const positions = [];
  for (const u of userPositions) {
    const positionAddr = u.position?.toString?.();
    const positionState = u.positionState;
    const poolAddr = positionState?.pool?.toString?.();
    const poolState = poolAddr ? poolStatesByAddr[poolAddr] : null;
    if (!positionAddr || !poolAddr || !poolState) continue;

    // --- in_range: pool sqrtPrice vs pool sqrtMin/sqrtMax (NOT positionState) ---
    const sqrtPrice = bnToNum(poolState.sqrtPrice);
    const sqrtMin = bnToNum(poolState.sqrtMinPrice);
    const sqrtMax = bnToNum(poolState.sqrtMaxPrice);
    const inRange =
      Number.isFinite(sqrtPrice) &&
      Number.isFinite(sqrtMin) &&
      Number.isFinite(sqrtMax) &&
      sqrtPrice >= sqrtMin &&
      sqrtPrice <= sqrtMax;

    // Mirror state.js OOR tracking so updatePnlAndCheckExits sees consistent state.
    try {
      if (inRange) markInRange(positionAddr);
      else markOutOfRange(positionAddr);
    } catch (e) {
      log("damm_state", `markInRange/OOR failed for ${positionAddr.slice(0, 8)}: ${e.message}`);
    }

    // --- price range for reporting (bin fields stay null) ---
    // Decimals unknown without an extra RPC per mint; skip Decimal price
    // conversion in Phase 1 — report sqrt-price boundaries as raw numbers.
    // lower_price/upper_price/current_price can be enriched in a later phase.
    const tokenAMint = poolState.tokenAMint?.toString?.() || null;
    const tokenBMint = poolState.tokenBMint?.toString?.() || null;

    // --- unclaimed fees (SDK helper) → USD via Jupiter prices ---
    let unclaimedFeesUsd = 0;
    try {
      const fees = getUnClaimLpFee(poolState, positionState);
      const feeAUsd = tokenAmountToUsd(
        fees.feeTokenA,
        tokenAMint ? decimalsByMint[tokenAMint] : 0,
        tokenAMint ? usdByMint[tokenAMint] : null,
      );
      const feeBUsd = tokenAmountToUsd(
        fees.feeTokenB,
        tokenBMint ? decimalsByMint[tokenBMint] : 0,
        tokenBMint ? usdByMint[tokenBMint] : null,
      );
      unclaimedFeesUsd = feeAUsd + feeBUsd;
    } catch (e) {
      log("damm_fees", `getUnClaimLpFee failed for ${positionAddr.slice(0, 8)}: ${e.message}`);
    }

    // --- PnL: UNAVAILABLE in Phase 1 (no deposit-history API for DAMM) ---
    const tracked = (() => { try { return getTrackedPosition(positionAddr); } catch { return null; } })();
    const ageMinutes = tracked?.deployed_at
      ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
      : null;

    const pair = tracked?.pool_name || (tokenAMint ? `${tokenAMint.slice(0, 4)}…/SOL` : "DAMM");

    positions.push({
      position: positionAddr,
      pool: poolAddr,
      pool_type: "damm_v2",
      pair,
      base_mint: tokenAMint,
      // Bin fields null — DAMM has no bins. Rules 3 & 4 in getDeterministicCloseRule
      // (which compare active_bin/upper_bin) are naturally skipped by their
      // `active_bin != null` guards.
      lower_bin: null,
      upper_bin: null,
      active_bin: null,
      in_range: inRange,
      // sqrt-price boundaries available for reporting (lower_price/upper_price/
      // current_price) but not yet in the canonical Position shape — omit until
      // the index.js report layer is taught to render them.
      unclaimed_fees_usd: round(unclaimedFeesUsd, 4),
      unclaimed_fees_true_usd: round(unclaimedFeesUsd, 4),
      total_value_usd: 0, // unknown without deposit history; suspicious flag set
      total_value_true_usd: 0,
      collected_fees_usd: 0,
      collected_fees_true_usd: 0,
      pnl_usd: 0,
      pnl_true_usd: 0,
      pnl_pct: null, // unavailable — see header
      pnl_pct_derived: null,
      pnl_pct_diff: null,
      pnl_pct_suspicious: true, // gates PnL-based exits off; OOR still works
      fee_per_tvl_24h: null, // no pool-stats fetch in Phase 1; LOW_YIELD skips
      age_minutes: ageMinutes,
      minutes_out_of_range: (() => { try { return minutesOutOfRange(positionAddr); } catch { return 0; } })(),
      instruction: tracked?.instruction || null,
    });
  }

  return positions;
}

// ─── Per-pool PnL fetch (parity with fetchDlmmPnlForPool's return shape) ──────
// No REST PnL API exists for DAMM (dlmm.datapi 404s). This builds the
// {[positionAddress]: entry} map from on-chain reads so the Meteora-fallback
// path in dlmm.js getMyPositions can consume DAMM and DLMM uniformly.
export async function fetchDammPnlForPool(poolAddress, walletAddress) {
  const wallet = String(walletAddress || "").trim();
  if (!wallet || !poolAddress) return {};
  try {
    const all = await getCpAmmPositions({ wallet_address: wallet });
    const byAddr = {};
    for (const p of all) {
      if (p.pool !== poolAddress) continue;
      // Translate the unified shape back to the Meteora-PnL-entry-ish fields
      // dlmm.js's fallback path reads (isOutOfRange, sqrt-price as pseudo-bins).
      byAddr[p.position] = {
        isOutOfRange: !p.in_range,
        sqrtPrice: null, // populated below if available
        sqrtMinPrice: null,
        sqrtMaxPrice: null,
        lowerBinId: null,
        upperBinId: null,
        poolActiveBinId: null,
        // Carry through the USD figures we computed.
        unrealizedPnl: {
          balances: p.total_value_usd,
          balancesSol: 0,
          unclaimedFeeTokenX: { usd: p.unclaimed_fees_usd, amountSol: 0 },
          unclaimedFeeTokenY: { usd: 0, amountSol: 0 },
        },
        allTimeDeposits: { total: { usd: 0, sol: 0 } },
        allTimeWithdrawals: { total: { usd: 0, sol: 0 } },
        allTimeFees: { total: { usd: 0, sol: 0 } },
        feePerTvl24h: null,
        createdAt: null,
        pool_type: "damm_v2",
      };
    }
    return byAddr;
  } catch (e) {
    log("damm_pnl", `fetchDammPnlForPool ${poolAddress.slice(0, 8)} failed: ${e.message}`);
    return {};
  }
}

// ─── Phase 2: Deploy / Close / Claim ──────────────────────────────────────────
// Mirrors tools/dlmm.js deployPosition/closePosition/claimFees return shapes so
// the executor's post-tool side effects (notifyDeploy/notifyClose/notifySwap,
// auto-swap, pool-memory note) fire unchanged. The executor dispatches to these
// by pool_type — no new tool names. SDK auto-wraps native SOL inside all three
// high-level methods (createPositionAndAddLiquidity, claimPositionFee,
// removeAllLiquidityAndClosePosition), so there is NO manual WSOL handling here.

// Find a DAMM position's pool + live state. Mirrors dlmm.js lookupPoolForPosition:
// state registry first (fast path), then SDK scan.
async function lookupDammPosition(position_address, walletAddress) {
  const { CpAmm } = await getCpAmm();
  const conn = getPnlConnection();
  const cpAmm = new CpAmm(conn);
  const userPositions = await cpAmm.getPositionsByUser(new PublicKey(walletAddress));
  for (const u of userPositions || []) {
    if (u.position?.toString?.() === position_address) {
      return u;
    }
  }
  throw new Error(`DAMM position ${position_address} not found in wallet positions`);
}

// Identify which side of the pool is SOL. DAMM pools can quote either token as A
// or B; the agent deploys single-sided SOL via amount_y. Returns the SOL-side
// index (0 = tokenA, 1 = tokenB) so the deploy can place the full amount on the
// SOL leg and 0 on the base leg.
function solSideIndex(poolState) {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (poolState.tokenAMint?.toString?.() === SOL_MINT) return 0;
  if (poolState.tokenBMint?.toString?.() === SOL_MINT) return 1;
  throw new Error("DAMM pool does not quote SOL on either leg — single-side SOL deploy unsupported for this pool.");
}

/**
 * Deploy single-sided SOL into a DAMM v2 pool.
 * The position inherits the pool's fixed sqrtMin/sqrtMax range (no per-position
 * range). The downside_pct/upside_pct intent is enforced as a pool-selection
 * bound by the screener + executor safety rail BEFORE this runs — here we only
 * compute liquidityDelta and submit the tx.
 */
export async function deployDammPosition({
  pool_address,
  amount_sol,
  amount_x,
  amount_y,
  downside_pct,
  upside_pct,
  pool_name,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  entry_mcap,
  entry_tvl,
  entry_volume,
  entry_holders,
}) {
  const poolAddress = String(pool_address || "").trim();
  if (!poolAddress) throw new Error("pool_address is required for DAMM deploy");

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_deploy: { pool_address: poolAddress, amount_y: amount_y ?? amount_sol ?? 0, pool_type: "damm_v2" },
      message: "DRY RUN — no transaction sent",
    };
  }

  if (isPoolOnCooldown(poolAddress)) {
    log("damm_deploy", `Pool ${poolAddress.slice(0, 8)} is on cooldown — skipping`);
    return { success: false, error: "Pool on cooldown — was recently closed with a cooldown reason. Try a different pool." };
  }

  const finalAmountY = Number(amount_y ?? amount_sol ?? 0);
  const finalAmountX = Number(amount_x ?? 0);
  if (!Number.isFinite(finalAmountY) || !Number.isFinite(finalAmountX) || finalAmountY < 0 || finalAmountX < 0) {
    throw new Error("Invalid deploy amount: amount_x and amount_y must be valid non-negative numbers.");
  }
  if (finalAmountX > 0) {
    throw new Error("Unsupported deploy amount: DAMM deploys are single-side SOL. Use amount_y/amount_sol and keep amount_x=0.");
  }
  let deployAmountSol = finalAmountY;
  if (deployAmountSol <= 0) {
    deployAmountSol = computeDeployAmount((await getWalletBalances()).sol);
  }
  if (!Number.isFinite(deployAmountSol) || deployAmountSol <= 0) {
    throw new Error("Invalid deploy amount: provide a positive amount_y/amount_sol.");
  }

  const {
    CpAmm, getPriceFromSqrtPrice, convertToLamports, getTokenProgram, derivePositionAddress,
  } = await getCpAmm();
  const conn = getConnection();
  const cpAmm = new CpAmm(conn);
  const wallet = getWallet();

  // 1. Fetch pool state (range lives here, not on the position).
  const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
  if (!poolState) throw new Error(`DAMM pool ${poolAddress} not found / fetchPoolState returned null`);

  const solSide = solSideIndex(poolState);
  const tokenAMint = poolState.tokenAMint;
  const tokenBMint = poolState.tokenBMint;
  const tokenAProgram = getTokenProgram(poolState.tokenAFlag);
  const tokenBProgram = getTokenProgram(poolState.tokenBFlag);

  // 2. SOL-side decimals = 9 (native/WSOL). Convert amount_y (SOL) → lamports BN.
  const solDecimals = 9;
  const solLamports = convertToLamports(deployAmountSol, solDecimals);
  // Single-sided: full amount on the SOL leg, 0 on the base leg.
  const maxAmountTokenA = solSide === 0 ? solLamports : new BN(0);
  const maxAmountTokenB = solSide === 1 ? solLamports : new BN(0);

  // 3. Compute liquidityDelta from the pool's fixed range + current sqrt price.
  const liquidityDelta = cpAmm.getLiquidityDelta({
    maxAmountTokenA,
    maxAmountTokenB,
    sqrtPrice: poolState.sqrtPrice,
    sqrtMinPrice: poolState.sqrtMinPrice,
    sqrtMaxPrice: poolState.sqrtMaxPrice,
    collectFeeMode: poolState.collectFeeMode,
  });

  // 4. Mint the position NFT keypair + derive the position PDA.
  const positionNft = Keypair.generate();
  const positionPda = derivePositionAddress(positionNft.publicKey);

  // 5. Build the tx. SDK auto-wraps SOL → WSOL before deposit, unwraps after.
  const tx = await cpAmm.createPositionAndAddLiquidity({
    owner: wallet.publicKey,
    pool: new PublicKey(poolAddress),
    positionNft: positionNft.publicKey,
    liquidityDelta,
    maxAmountTokenA,
    maxAmountTokenB,
    tokenAAmountThreshold: new BN(0),
    tokenBAmountThreshold: new BN(0),
    tokenAMint,
    tokenBMint,
    tokenAProgram,
    tokenBProgram,
  });

  // 6. Sign with wallet (owner/payer) + positionNft (the fresh mint), send, confirm.
  const txHash = await sendAndConfirmTransaction(conn, tx, [wallet, positionNft], { commitment: "confirmed" });
  log("damm_deploy", `Deployed DAMM position ${positionPda.toString().slice(0, 8)} in pool ${poolAddress.slice(0, 8)}: ${txHash}`);

  // 7. Reporting: current/min/max price in USD (base-token units) for the return shape.
  const baseMint = (solSide === 0 ? tokenBMint : tokenAMint).toString();
  // getPriceFromSqrtPrice returns a Decimal; convert to JS number via toString().
  const currentPrice = Number(getPriceFromSqrtPrice(poolState.sqrtPrice, 9, 9).toString());
  const minPrice = Number(getPriceFromSqrtPrice(poolState.sqrtMinPrice, 9, 9).toString());
  const maxPrice = Number(getPriceFromSqrtPrice(poolState.sqrtMaxPrice, 9, 9).toString());
  const downsideGap = currentPrice > 0 ? (currentPrice - minPrice) / currentPrice * 100 : 0;
  const upsideGap = currentPrice > 0 ? (maxPrice - currentPrice) / currentPrice * 100 : 0;
  const widthPct = currentPrice > 0 ? (maxPrice - minPrice) / currentPrice * 100 : 0;

  // 8. Track + log.
  trackPosition({
    position: positionPda.toString(),
    pool: poolAddress,
    pool_name,
    strategy: "damm_v2_spot",
    bin_range: null, // DAMM positions carry no per-position range
    amount_sol: deployAmountSol,
    amount_x: 0,
    active_bin: null,
    bin_step: null,
    volatility,
    fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    pool_type: "damm_v2",
  });

  appendDecision({
    type: "deploy",
    actor: "SCREENER",
    pool: poolAddress,
    pool_name: pool_name || poolAddress.slice(0, 8),
    position: positionPda.toString(),
    summary: `Deployed ${deployAmountSol} SOL into DAMM v2 pool`,
    reason: "Screener-selected DAMM v2 candidate",
    risks: [
      `downside_gap ${downsideGap.toFixed(1)}%`,
      `upside_gap ${upsideGap.toFixed(1)}%`,
      volatility != null ? `volatility ${volatility}` : null,
    ].filter(Boolean),
    metrics: {
      amount_sol: deployAmountSol,
      pool_type: "damm_v2",
      downside_gap_pct: round(downsideGap, 2),
      upside_gap_pct: round(upsideGap, 2),
    },
  });

  return {
    success: true,
    position: positionPda.toString(),
    pool: poolAddress,
    pool_name,
    bin_range: null,
    price_range: { min: minPrice, max: maxPrice },
    range_coverage: {
      downside_pct: downsideGap,
      upside_pct: upsideGap,
      width_pct: widthPct,
      active_price: currentPrice,
    },
    bin_step: null,
    base_fee: null, // DAMM fee bps available on poolState.poolFees if needed later
    strategy: "damm_v2_spot",
    wide_range: false,
    amount_x: 0,
    amount_y: deployAmountSol,
    txs: [txHash],
  };
}

/**
 * Close a DAMM v2 position atomically: claim fees + remove all liquidity + close
 * the position NFT. The SDK's removeAllLiquidityAndClosePosition does all three
 * in one tx and auto-unwraps WSOL → SOL on the way out.
 */
export async function closeDammPosition({ position_address, reason }) {
  const positionAddress = String(position_address || "").trim();
  if (!positionAddress) throw new Error("position_address is required for DAMM close");

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: positionAddress, pool_type: "damm_v2", message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(positionAddress);
  const { CpAmm, getCurrentPoint } = await getCpAmm();
  const conn = getConnection();
  const cpAmm = new CpAmm(conn);
  const wallet = getWallet();
  const walletAddress = wallet.publicKey.toString();

  try {
    log("damm_close", `Closing DAMM position: ${positionAddress}`);

    // 1. Locate pool + position + poolState.
    const userPosition = await lookupDammPosition(positionAddress, walletAddress);
    const poolAddress = userPosition.positionState?.pool?.toString?.();
    if (!poolAddress) throw new Error(`Could not resolve pool for DAMM position ${positionAddress}`);
    const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
    if (!poolState) throw new Error(`DAMM pool ${poolAddress} fetchPoolState returned null`);
    const positionState = userPosition.positionState;
    const positionNftAccount = userPosition.positionNftAccount;

    // 2. Vestings + currentPoint (required by removeAllLiquidityAndClosePosition).
    const vestings = await cpAmm.getAllVestingsByPosition(new PublicKey(positionAddress));
    const currentPoint = await getCurrentPoint(conn, poolState.activationType);

    // 3. Build + sign + send the atomic close tx.
    const tx = await cpAmm.removeAllLiquidityAndClosePosition({
      owner: wallet.publicKey,
      position: new PublicKey(positionAddress),
      positionNftAccount,
      poolState,
      positionState,
      tokenAAmountThreshold: new BN(0),
      tokenBAmountThreshold: new BN(0),
      vestings,
      currentPoint,
    });
    const txHash = await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
    log("damm_close", `Close tx confirmed: ${txHash}`);

    const closeTxHashes = [txHash];
    const claimTxHashes = []; // fees claimed inside the same atomic tx
    const txHashes = [...claimTxHashes, ...closeTxHashes];

    // 4. Verify the position is gone (mirror DLMM close's 4-retry verify loop).
    await new Promise((r) => setTimeout(r, 5000));
    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const remaining = await cpAmm.getPositionsByUser(new PublicKey(walletAddress));
        const stillOpen = (remaining || []).some((u) => u.position?.toString?.() === positionAddress);
        if (!stillOpen) { closedConfirmed = true; break; }
        log("damm_close_warn", `Position ${positionAddress.slice(0, 8)} still appears open after close (attempt ${attempt + 1}/4)`);
      } catch (e) {
        log("damm_close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: positionAddress,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    recordClose(positionAddress, reason || "agent decision");

    // 5. Performance record. Phase 2 ships pnl_pct=null (no tx-event ledger yet —
    // Phase 2.1). final_value_usd is unknown without deposit history; record a
    // minimal perf entry so lessons.json still gets a row, with pnl_pct null.
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);
      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }
      const closeBaseMint = (poolState.tokenAMint?.toString?.() === "So11111111111111111111111111111111111111112")
        ? poolState.tokenBMint?.toString?.()
        : poolState.tokenAMint?.toString?.();

      await recordPerformance({
        position: positionAddress,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolAddress.slice(0, 8),
        base_mint: closeBaseMint,
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: null,
        volatility: tracked.volatility ?? null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: tracked.total_fees_claimed_usd || 0,
        final_value_usd: 0, // unknown without deposit-history ledger (Phase 2.1)
        initial_value_usd: tracked.initial_value_usd || 0,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        signal_snapshot: null,
        entry_mcap: tracked.entry_mcap ?? null,
        entry_tvl: tracked.entry_tvl ?? null,
        entry_volume: tracked.entry_volume ?? null,
        entry_holders: tracked.entry_holders ?? null,
      });

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: tracked.pool_name || poolAddress.slice(0, 8),
        position: positionAddress,
        summary: "Closed DAMM v2 position (pnl unavailable in phase 2)",
        reason: reason || "agent decision",
        risks: [
          minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
          tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
        ].filter(Boolean),
        metrics: {
          minutes_held: minutesHeld,
          pool_type: "damm_v2",
          pnl_pct: null,
        },
      });

      return {
        success: true,
        position: positionAddress,
        pool: poolAddress,
        pool_name: tracked.pool_name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: 0,
        pnl_pct: null,
        base_mint: closeBaseMint,
      };
    }

    // No tracked position — close went through but we can't record performance.
    const untrackedBaseMint = (poolState.tokenAMint?.toString?.() === "So11111111111111111111111111111111111111112")
      ? poolState.tokenBMint?.toString?.()
      : poolState.tokenAMint?.toString?.();
    appendDecision({
      type: "close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: poolAddress.slice(0, 8),
      position: positionAddress,
      summary: "Closed untracked DAMM v2 position",
      reason: reason || "agent decision",
      metrics: {},
    });
    return {
      success: true,
      position: positionAddress,
      pool: poolAddress,
      pool_name: null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: untrackedBaseMint,
    };
  } catch (error) {
    log("damm_close_error", `closeDammPosition failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Claim accumulated fees from a DAMM v2 position. SDK auto-unwraps WSOL → SOL.
 */
export async function claimDammFees({ position_address }) {
  const positionAddress = String(position_address || "").trim();
  if (!positionAddress) throw new Error("position_address is required for DAMM claim");

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: positionAddress, pool_type: "damm_v2", message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(positionAddress);
  if (tracked?.closed) {
    return { success: false, error: "Position is already closed — nothing to claim." };
  }

  const { CpAmm, getUnClaimLpFee, getTokenDecimals, getTokenProgram, deriveTokenVaultAddress } = await getCpAmm();
  const conn = getConnection();
  const cpAmm = new CpAmm(conn);
  const wallet = getWallet();
  const walletAddress = wallet.publicKey.toString();

  try {
    const userPosition = await lookupDammPosition(positionAddress, walletAddress);
    const poolAddress = userPosition.positionState?.pool?.toString?.();
    if (!poolAddress) throw new Error(`Could not resolve pool for DAMM position ${positionAddress}`);
    const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
    if (!poolState) throw new Error(`DAMM pool ${poolAddress} fetchPoolState returned null`);
    const positionState = userPosition.positionState;
    const positionNftAccount = userPosition.positionNftAccount;

    // Read pre-claim unclaimed fees (USD) for recordClaim + return.
    let feesUsd = 0;
    try {
      const fees = getUnClaimLpFee(poolState, positionState);
      const tokenAMint = poolState.tokenAMint.toString();
      const tokenBMint = poolState.tokenBMint.toString();
      const [usdByMint, decByMint] = await Promise.all([
        getJupiterUsdPrices([tokenAMint, tokenBMint]),
        (async () => {
          const byMint = {};
          byMint[tokenAMint] = await getTokenDecimals(conn, new PublicKey(tokenAMint)).catch(() => 0);
          byMint[tokenBMint] = await getTokenDecimals(conn, new PublicKey(tokenBMint)).catch(() => 0);
          return byMint;
        })(),
      ]);
      const feeAUsd = tokenAmountToUsd(fees.feeTokenA, decByMint[tokenAMint], usdByMint[tokenAMint]);
      const feeBUsd = tokenAmountToUsd(fees.feeTokenB, decByMint[tokenBMint], usdByMint[tokenBMint]);
      feesUsd = feeAUsd + feeBUsd;
    } catch (e) {
      log("damm_claim_warn", `Pre-claim fee USD read failed: ${e.message}`);
    }

    const tokenAProgram = getTokenProgram(poolState.tokenAFlag);
    const tokenBProgram = getTokenProgram(poolState.tokenBFlag);

    const tx = await cpAmm.claimPositionFee({
      owner: wallet.publicKey,
      position: new PublicKey(positionAddress),
      pool: new PublicKey(poolAddress),
      positionNftAccount,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: deriveTokenVaultAddress(poolState.tokenAMint, new PublicKey(poolAddress)),
      tokenBVault: deriveTokenVaultAddress(poolState.tokenBMint, new PublicKey(poolAddress)),
      tokenAProgram,
      tokenBProgram,
    });
    const txHash = await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
    log("damm_claim", `Claim tx confirmed: ${txHash}`);

    recordClaim(positionAddress, feesUsd);
    const baseMint = (poolState.tokenAMint?.toString?.() === "So11111111111111111111111111111111111111112")
      ? poolState.tokenBMint?.toString?.()
      : poolState.tokenAMint?.toString?.();

    return {
      success: true,
      position: positionAddress,
      txs: [txHash],
      fees_usd: round(feesUsd, 4),
      base_mint: baseMint,
    };
  } catch (error) {
    log("damm_claim_error", `claimDammFees failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}
