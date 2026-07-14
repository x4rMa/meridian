import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { confirmIndicatorPreset } from "./chart-indicators.js";
import { getAgentMeridianBase, getAgentMeridianHeaders } from "./agent-meridian.js";
import { getGmgnTrending } from "./gmgn.js";
import { searchPools } from "./dlmm.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
// Degen Score normalizes window-dependent inputs (volume/fee/LP) to this reference
// window, so its targets stay valid regardless of the configured screening timeframe.
const DEGEN_REFERENCE_MINUTES = 30;
const PVP_SHORTLIST_LIMIT = 2;
const PVP_RIVAL_LIMIT = 2;
const PVP_MIN_ACTIVE_TVL = 5_000;
const PVP_MIN_HOLDERS = 500;
const PVP_MIN_GLOBAL_FEES_SOL = 30;

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

export function scoreCandidate(pool) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;
}

/**
 * 24h fee revenue (USD) for the fee gate.
 * Prefers the real 24h fee fetched from the API (pool.fee_24h, populated by
 * enrichFee24hForPools). Falls back to a linear extrapolation from the window-
 * period fee — but that extrapolation is noisy on short timeframes (a single
 * quiet 5m slice can undercount real 24h fees by 4-5×), so the real value is
 * strongly preferred whenever available.
 */
export function estimateFee24hUsd(pool) {
  const fee24h = Number(pool?.fee_24h);
  if (Number.isFinite(fee24h) && fee24h > 0) return fee24h;
  const feeWindow = Number(pool?.fee_window ?? pool?.fee ?? 0);
  if (!Number.isFinite(feeWindow) || feeWindow <= 0) return 0;
  const tfMinutes = TIMEFRAME_MINUTES[config.screening.timeframe] || DEGEN_REFERENCE_MINUTES;
  const scale = 1440 / tfMinutes;
  return feeWindow * scale;
}

/**
 * Fetch the real 24h fee AND volume for every pool.
 * The configured screening timeframe (often 5m) undercounts 24h activity badly
 * for pools that are momentarily quiet — a single dead 5m slice can read
 * volume=0 fee=0 even on a pool doing $4K+ in daily fees. The fee/active-TVL
 * and volume gates are therefore evaluated against the real 24h window, not
 * the timeframe window. Fetches both fields in one detail call per pool.
 *
 * The 5m fee_active_tvl_ratio is unreliable for the same reason, so this also
 * stamps a 24h-derived ratio (fee_24h / active_tvl) where the ratio gate can use it.
 */
async function enrichFee24hForPools(rawPools, s, tier) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return;
  // Both tiers need the real 24h window — the configured-timeframe slice is too
  // noisy to gate on. The midcap tier additionally uses the absolute-fee floor,
  // but the 24h fetch is the same call, so run it unconditionally.
  const needsFetch = rawPools.filter((pool) => {
    // Already enriched (e.g. Discord signal path) — skip the extra round-trip.
    const hasFee = Number.isFinite(Number(pool?.fee_24h)) && Number(pool.fee_24h) > 0;
    const hasVol = Number.isFinite(Number(pool?.volume_24h)) && Number(pool.volume_24h) > 0;
    return !(hasFee && hasVol);
  });
  if (needsFetch.length === 0) return;

  const results = await Promise.allSettled(
    needsFetch.map((pool) =>
      fetchPoolDiscoveryDetail({ poolAddress: pool.pool_address, timeframe: "24h" })
        .then((detail) => ({
          poolAddress: pool.pool_address,
          fee: numeric(detail?.fee),
          volume: numeric(detail?.volume),
          ratio: numeric(detail?.fee_active_tvl_ratio),
          volatility: numeric(detail?.volatility),
        }))
    )
  );
  let enriched = 0;
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { poolAddress, fee, volume, ratio, volatility } = result.value;
    const pool = rawPools.find((p) => p.pool_address === poolAddress);
    if (!pool) continue;
    if (Number.isFinite(fee) && fee > 0) pool.fee_24h = fee;
    if (Number.isFinite(volume) && volume > 0) pool.volume_24h = volume;
    // 24h fee/active-TVL ratio — stored separately so the gate can prefer it
    // over the noisy timeframe ratio. A momentarily-quiet 5m slice reads
    // ratio≈0 even on a pool doing 0.93/day, so the timeframe ratio is not a
    // trustworthy gate input. The timeframe ratio is kept for scoring.
    if (Number.isFinite(ratio) && ratio > 0) pool.fee_active_tvl_ratio_24h = ratio;
    // 24h volatility — stamped onto the canonical `volatility` field when the
    // timeframe+volatility-timeframe fetches both returned 0. A pool that's been
    // quiet for >30m but traded in the last 24h has real price variance that
    // the 24h window captures and the 30m window misses. Tag the timeframe so
    // diagnostics reflect which window the volatility came from.
    if (Number.isFinite(volatility) && volatility > 0 && !isUsableVolatility(pool.volatility)) {
      pool.volatility = volatility;
      pool.volatility_timeframe = "24h";
    }
    enriched++;
  }
  if (enriched > 0) log("screening", `${tier}: fetched real 24h fee/volume for ${enriched}/${needsFetch.length} pool(s)`);
}

/**
 * Fee gate: OR-logic between a ratio floor and an absolute USD floor.
 * A pool passes if EITHER:
 *   - fee_active_tvl_ratio >= minFeeActiveTvlRatio (ratio gate — catches efficient small pools), OR
 *   - estimatedFee24hUsd    >= minFee24hUsd       (absolute floor — catches fat-fee large pools
 *                                                  that the ratio gate structurally rejects)
 * minFee24hUsd=null disables the absolute floor (pure ratio mode, the legacy behavior).
 */
export function passesFeeGate(pool, { minFeeActiveTvlRatio, minFee24hUsd = null }) {
  // Prefer the 24h fee/active-TVL ratio when available — the timeframe ratio
  // (often 5m) reads near-zero on momentarily-quiet pools and structurally
  // rejects healthy daily-fee pools. Fall back to the timeframe ratio only
  // if the 24h fetch failed.
  const ratio24h = Number(pool?.fee_active_tvl_ratio_24h);
  const ratioTf = Number(pool?.fee_active_tvl_ratio);
  const ratio = (Number.isFinite(ratio24h) && ratio24h > 0)
    ? ratio24h
    : (Number.isFinite(ratioTf) ? ratioTf : NaN);
  if (Number.isFinite(ratio) && Number.isFinite(minFeeActiveTvlRatio) && ratio >= minFeeActiveTvlRatio) {
    return true;
  }
  if (minFee24hUsd != null && Number.isFinite(minFee24hUsd) && minFee24hUsd > 0) {
    const fee24h = estimateFee24hUsd(pool);
    if (fee24h >= minFee24hUsd) return true;
  }
  return false;
}

/**
 * Degen Score — a pool's efficiency relative to its liquidity, on a 0..100 scale.
 * Geometric mean of four liquidity-relative sub-scores so a HIGH score requires balance
 * across all four (a pool spiking one metric can't dominate):
 *   1. Recent trading activity   → volume / active_tvl   (volume_active_tvl_ratio)
 *   2. Recent LP activity        → unique_lps + positions_created
 *   3. Fees paid to LPs          → fee / active_tvl       (fee_active_tvl_ratio)
 *   4. Liquidity                 → active_tvl (log floor — dust pools can't win on ratios)
 * Efficiency only (no momentum/change_pct), per design. Targets are configurable so the
 * score can be calibrated; each sub-score saturates at its target.
 *
 * The volume/fee/LP inputs are measured over `config.screening.timeframe`, so they are
 * normalized to a fixed 30m reference window before scoring — the targets are expressed
 * in 30m terms and stay valid even if the timeframe changes (5m, 1h, 24h, …). Liquidity
 * is a level, not a rate, so it is not scaled.
 */
export function degenScore(pool, targets = {}) {
  const {
    targetVolRatio = 20,    // (30m) volume/active_tvl that earns a full trading sub-score
    targetLpCount = 40,     // (30m) unique_lps + positions_created for a full LP sub-score
    targetFeeRatio = 0.20,  // (30m) fee/active_tvl for a full fee sub-score
    targetLiquidity = 20000, // active_tvl ($) floor for full liquidity sub-score (not timeframe-scaled)
  } = targets;

  const La = Number(pool.active_tvl ?? pool.tvl ?? 0);
  if (!Number.isFinite(La) || La <= 0) return 0;

  const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

  // Normalize window-dependent inputs to the 30m reference (rate × scale).
  const tfMinutes = TIMEFRAME_MINUTES[config.screening.timeframe] || DEGEN_REFERENCE_MINUTES;
  const tfScale = DEGEN_REFERENCE_MINUTES / tfMinutes;

  const volRatio = Number(pool.volume_active_tvl_ratio);
  const tradingRatio = (Number.isFinite(volRatio) ? volRatio : Number(pool.volume_window || 0) / La) * tfScale;
  const feeRatio = (Number.isFinite(Number(pool.fee_active_tvl_ratio))
    ? Number(pool.fee_active_tvl_ratio)
    : Number(pool.fee_window || 0) / La) * tfScale;
  const lpActivity = (Number(pool.unique_lps || 0) + Number(pool.positions_created || 0)) * tfScale;

  const sTrading = clamp01(tradingRatio / targetVolRatio);
  const sLp      = clamp01(lpActivity / targetLpCount);
  const sFees    = clamp01(feeRatio / targetFeeRatio);
  const sLiq     = clamp01(Math.log10(La) / Math.log10(targetLiquidity));

  // Geometric mean (×100). Any zero sub-score → 0, enforcing balance across all four.
  return (sTrading * sLp * sFees * sLiq) ** 0.25 * 100;
}

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUsableVolatility(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null;
}

function getPoolBaseMint(pool) {
  return pool?.token_x?.address ||
    pool?.base_token_address ||
    pool?.base_mint ||
    pool?.base?.mint ||
    null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

export function getRawPoolScreeningRejectReason(pool, s, tier = "degen") {
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  const volatility = numeric(pool?.volatility);
  const volume = numeric(pool?.volume);
  const holders = numeric(pool?.base_token_holders);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = numeric(base?.organic_score);
  const quoteOrganic = numeric(quote?.organic_score);
  const launchpad = getPoolLaunchpad(pool);
  const createdAt = numeric(base?.created_at);

  // ── Age bands ────────────────────────────────────────────────────────────
  // When tokenAgeBands is configured, a pool passes the age gate iff its token
  // age falls inside ANY band. The admitting band's `thresholds` shallow-merge
  // over the base screening config `s` to form the effective config used for
  // ALL subsequent gates (TVL, organic, fee/TVL, …) — so a "mature" band can
  // demand higher TVL while relaxing organic, per-regime. Empty bands ⇒ legacy
  // single min/maxTokenAgeHours gate. The matched band name + screeningProfile
  // are stamped on the pool so they flow into the deploy signal_snapshot and
  // attribute historical trades to the policy that selected them.
  const bands = Array.isArray(s.tokenAgeBands) ? s.tokenAgeBands : [];
  let ageBandName = null;
  let ageBandProfile = null;
  let effectiveS = s;
  if (bands.length > 0) {
    const ageHours = createdAt != null
      ? Math.max(0, (Date.now() - createdAt) / 3_600_000)
      : null;
    const admitting = ageHours != null
      ? bands.find((b) => {
          const lo = b.minHours != null ? b.minHours : -Infinity;
          const hi = b.maxHours != null ? b.maxHours : Infinity;
          return ageHours >= lo && ageHours <= hi;
        })
      : null;
    if (!admitting) {
      const createdStr = createdAt != null ? `age ${(ageHours ?? 0).toFixed(1)}h` : "created_at unknown";
      return `token ${createdStr} outside all configured age bands`;
    }
    ageBandName = admitting.name;
    ageBandProfile = admitting.screeningProfile;
    if (admitting.thresholds && typeof admitting.thresholds === "object") {
      effectiveS = { ...s, ...admitting.thresholds };
    }
    // Stamp on the raw pool so condensePool can surface it to the LLM, and so
    // the screening cycle can read it when staging the deploy signal snapshot.
    if (pool && typeof pool === "object") {
      pool._age_band = ageBandName;
      pool._screening_profile = ageBandProfile;
      pool._token_age_hours = ageHours;
    }
  } else {
    // Legacy path: stamp the token age for the deploy signal snapshot even
    // when bands aren't configured, so instrumentation still captures it.
    if (pool && typeof pool === "object" && pool._token_age_hours == null) {
      pool._token_age_hours = createdAt != null
        ? Math.max(0, (Date.now() - createdAt) / 3_600_000)
        : null;
    }
  }
  s = effectiveS;
  const isMidcap = tier === "midcap";
  const minMcap        = isMidcap ? (s.midcapMinMcap ?? s.minMcap)            : s.minMcap;
  const maxMcap        = isMidcap ? (s.midcapMaxMcap ?? s.maxMcap)            : s.maxMcap;
  const minHolders     = isMidcap ? (s.midcapMinHolders ?? s.minHolders)      : s.minHolders;
  const minTvl         = isMidcap ? (s.midcapMinTvl ?? s.minTvl)              : s.minTvl;
  const maxTvl         = isMidcap ? (s.midcapMaxTvl ?? s.maxTvl)              : s.maxTvl;
  const minBinStep     = isMidcap ? (s.midcapMinBinStep ?? s.minBinStep)      : s.minBinStep;
  const maxBinStep     = isMidcap ? (s.midcapMaxBinStep ?? s.maxBinStep)      : s.maxBinStep;
  const minOrganic     = isMidcap ? (s.midcapMinOrganic ?? s.minOrganic)      : s.minOrganic;
  const minQuoteOrganic = isMidcap ? (s.midcapMinOrganic ?? s.minQuoteOrganic): s.minQuoteOrganic;
  const maxTokenAgeHours = isMidcap ? (s.midcapMaxTokenAgeHours ?? s.maxTokenAgeHours) : s.maxTokenAgeHours;
  // Fee gate: degen = pure ratio (legacy); midcap = ratio OR absolute USD floor.
  const feeGateOpts = isMidcap
    ? { minFeeActiveTvlRatio: s.midcapMinFeeActiveTvlRatio ?? s.minFeeActiveTvlRatio, minFee24hUsd: s.midcapMinFee24hUsd }
    : { minFeeActiveTvlRatio: s.minFeeActiveTvlRatio };

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) {
    return "base token has high supply concentration";
  }
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && !["dlmm", "damm_v2"].includes(pool.pool_type)) return `pool_type ${pool.pool_type} is not dlmm/damm_v2`;

  if (mcap == null || mcap < minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${minMcap}`;
  if (mcap > maxMcap) return `mcap ${mcap} above maxMcap ${maxMcap}`;
  if (holders == null || holders < minHolders) return `holders ${holders ?? "unknown"} below minHolders ${minHolders}`;
  // Volume gate: evaluate against the real 24h window (enriched by
  // enrichFee24hForPools), not the configured-timeframe slice. A momentarily
  // quiet 5m window reads volume=0 even on an active pool, which would
  // structurally reject healthy pools. Fall back to timeframe volume only if
  // the 24h fetch failed — and then only admit it if nonzero (a true 0 on both
  // windows means genuinely dead).
  const volume24h = numeric(pool?.volume_24h);
  const effectiveVolume = (Number.isFinite(volume24h) && volume24h > 0)
    ? volume24h
    : (Number.isFinite(volume) && volume > 0 ? volume : 0);
  if (effectiveVolume < s.minVolume) {
    return `24h volume ${effectiveVolume.toFixed(0)} below minVolume ${s.minVolume}`;
  }
  if (tvl == null || tvl < minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${minTvl}`;
  if (maxTvl != null && tvl > maxTvl) return `TVL ${tvl} above maxTvl ${maxTvl}`;

  // ── Bin-step check: DLMM only. DAMM v2 pools have no bin_step ────────────────
  // (the position inherits the pool's fixed sqrtMin/sqrtMax range instead).
  if (pool?.pool_type !== "damm_v2") {
    if (binStep == null || binStep < minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${minBinStep}`;
    if (binStep > maxBinStep) return `bin_step ${binStep} above maxBinStep ${maxBinStep}`;
  } else {
    // ── DAMM v2 range gate: pool's fixed range must bracket current price ────
    // downside_gap = (pool_price - min_price) / pool_price
    // upside_gap   = (max_price - pool_price) / pool_price
    // Both must meet the configured floors (dammMinDownsidePct / dammMinUpsidePct).
    // The pool-discovery REST API returns pool_price/min_price/max_price for DAMM.
    const pp = numeric(pool?.pool_price);
    const pmin = numeric(pool?.min_price);
    const pmax = numeric(pool?.max_price);
    if (pp == null || pmin == null || pmax == null || pp <= 0) {
      return `DAMM v2 pool missing pool_price/min_price/max_price for range check`;
    }
    const downsideGap = ((pp - pmin) / pp) * 100;
    const upsideGap = ((pmax - pp) / pp) * 100;
    const reqDownside = numeric(s.dammMinDownsidePct);
    const reqUpside = numeric(s.dammMinUpsidePct);
    if (reqDownside != null && downsideGap < reqDownside) {
      return `Pool fixed range exceeds downside/upside risk bounds for DAMM v2 (downside_gap ${downsideGap.toFixed(2)}% < ${reqDownside}%)`;
    }
    if (reqUpside != null && upsideGap < reqUpside) {
      return `Pool fixed range exceeds downside/upside risk bounds for DAMM v2 (upside_gap ${upsideGap.toFixed(2)}% < ${reqUpside}%)`;
    }
  }

  if (!passesFeeGate(pool, feeGateOpts)) {
    const fee24h = estimateFee24hUsd(pool);
    const ratio24h = numeric(pool?.fee_active_tvl_ratio_24h);
    const shownRatio = (Number.isFinite(ratio24h) && ratio24h > 0) ? ratio24h : feeActiveTvlRatio;
    const floorStr = feeGateOpts.minFee24hUsd != null ? ` OR fee_24h $${fee24h.toFixed(0)} < $${feeGateOpts.minFee24hUsd}` : "";
    return `fee/active-TVL ${shownRatio ?? "unknown"} below ${feeGateOpts.minFeeActiveTvlRatio}${floorStr}`;
  }
  if (!isUsableVolatility(volatility)) {
    return `volatility ${volatility ?? "unknown"} is unusable`;
  }
  if (baseOrganic == null || baseOrganic < minOrganic) {
    return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${minOrganic}`;
  }
  if (quoteOrganic == null || quoteOrganic < minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${minQuoteOrganic}`;
  }
  if (
    pool?.discord_signal &&
    Array.isArray(s.allowedLaunchpads) &&
    s.allowedLaunchpads.length > 0 &&
    launchpad &&
    !includesCaseInsensitive(s.allowedLaunchpads, launchpad)
  ) {
    return `launchpad ${launchpad} not in allow-list`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) {
    return `blocked launchpad (${launchpad})`;
  }
  // Age gate. When bands are configured, the admitting band was resolved above
  // (a pool reaching this point already passed). When bands are empty, apply the
  // legacy single min/maxTokenAgeHours envelope.
  if (bands.length === 0) {
    if (s.minTokenAgeHours != null) {
      const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
      if (createdAt == null || createdAt > maxCreatedAt) return `token age below minTokenAgeHours ${s.minTokenAgeHours}`;
    }
    if (maxTokenAgeHours != null) {
      const minCreatedAt = Date.now() - maxTokenAgeHours * 3_600_000;
      if (createdAt == null || createdAt < minCreatedAt) return `token age above maxTokenAgeHours ${maxTokenAgeHours}`;
    }
  }
  return null;
}

async function fetchDiscordSignalCandidates() {
  const res = await fetch(`${getAgentMeridianBase()}/signals/discord/candidates`, {
    headers: getAgentMeridianHeaders(),
  });
  if (!res.ok) throw new Error(`discord signal candidates ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}`;

  // 20s hard timeout — without this a hung API connection stalls the screener
  // forever (the .catch(() => null) in runScreeningCycle can't help if the
  // promise never settles). AbortSignal.timeout lands a rejection instead.
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);

  // Tag primary-timeframe values on every pool before any overwrite
  for (const pool of rawPools) {
    if (!pool) continue;
    pool[`volume_${sourceTimeframe}`] = pool.volume ?? null;
    pool[`volatility_${sourceTimeframe}`] = pool.volatility ?? null;
    pool.volatility_timeframe = volatilityTimeframe;
  }

  if (sourceTimeframe === volatilityTimeframe) return rawPools;

  const uniquePoolAddresses = [...new Set(rawPools.map((pool) => pool?.pool_address).filter(Boolean))];
  const longResults = await Promise.allSettled(
    uniquePoolAddresses.map((poolAddress) =>
      fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
        .then((pool) => ({
          poolAddress,
          volatility: numeric(pool?.volatility),
          volume: numeric(pool?.volume),
        }))
    )
  );

  const metricsByPool = new Map();
  for (const result of longResults) {
    if (result.status !== "fulfilled") continue;
    metricsByPool.set(result.value.poolAddress, result.value);
  }

  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    const metrics = metricsByPool.get(pool.pool_address);
    if (!metrics) continue;

    pool[`volume_${volatilityTimeframe}`] = metrics.volume;
    pool[`volatility_${volatilityTimeframe}`] = metrics.volatility;

    // Use longer-timeframe values as the canonical ones for filtering
    if (metrics.volatility != null) pool.volatility = metrics.volatility;
    if (metrics.volume != null) pool.volume = metrics.volume;
  }

  return rawPools;
}

async function searchAssetsBySymbol(symbol) {
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

async function enrichDiscordSignalLaunchpads(rawPools) {
  const missing = rawPools.filter((pool) =>
    pool?.discord_signal &&
    !getPoolLaunchpad(pool) &&
    getPoolBaseMint(pool)
  );
  if (missing.length === 0) return;

  const uniqueMints = [...new Set(missing.map(getPoolBaseMint).filter(Boolean))];
  const results = await Promise.allSettled(
    uniqueMints.map(async (mint) => {
      const assets = await searchAssetsBySymbol(mint);
      const asset = assets.find((item) => item?.id === mint) || assets[0] || null;
      return { mint, asset };
    })
  );

  const byMint = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const launchpad = result.value.asset?.launchpad || result.value.asset?.launchpadPlatform || null;
    if (!launchpad) continue;
    byMint.set(result.value.mint, {
      launchpad,
      dev: result.value.asset?.dev || null,
      holderCount: numeric(result.value.asset?.holderCount),
      organicScore: numeric(result.value.asset?.organicScore),
      marketCap: numeric(result.value.asset?.mcap ?? result.value.asset?.fdv),
      createdAt: result.value.asset?.createdAt ? Date.parse(result.value.asset.createdAt) : null,
    });
  }

  for (const pool of missing) {
    const mint = getPoolBaseMint(pool);
    const asset = byMint.get(mint);
    if (!asset) continue;
    pool.token_x ||= {};
    pool.token_x.launchpad = asset.launchpad;
    pool.base_token_launchpad = asset.launchpad;
    if (asset.dev && !pool.token_x.dev) pool.token_x.dev = asset.dev;
    if (asset.holderCount != null && pool.base_token_holders == null) pool.base_token_holders = asset.holderCount;
    if (asset.organicScore != null && pool.token_x.organic_score == null) pool.token_x.organic_score = asset.organicScore;
    if (asset.marketCap != null && pool.token_x.market_cap == null) pool.token_x.market_cap = asset.marketCap;
    if (asset.createdAt != null && pool.token_x.created_at == null) pool.token_x.created_at = asset.createdAt;
    log("screening", `Discord signal launchpad enriched from Jupiter: ${pool.name || mint} — ${asset.launchpad}`);
  }
}

async function findRivalPool(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rival pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

async function enrichPvpRisk(pools) {
  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, PVP_SHORTLIST_LIMIT);

  if (shortlist.length === 0) return;

  const symbolCache = new Map();

  await Promise.all(shortlist.map(async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    const ownMint = pool.base?.mint;
    if (!symbol || !ownMint) return;

    let assets = symbolCache.get(symbol);
    if (!assets) {
      assets = await searchAssetsBySymbol(symbol).catch(() => []);
      symbolCache.set(symbol, assets);
    }

    const rivalAssets = assets
      .filter((asset) => normalizeSymbol(asset?.symbol) === symbol && asset?.id && asset.id !== ownMint)
      .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
      .slice(0, PVP_RIVAL_LIMIT);

    for (const rival of rivalAssets) {
      const rivalHolders = Number(rival?.holderCount || 0);
      const rivalFees = Number(rival?.fees || 0);
      if (rivalHolders < PVP_MIN_HOLDERS || rivalFees < PVP_MIN_GLOBAL_FEES_SOL) continue;

      const rivalPool = await findRivalPool(rival.id).catch(() => null);
      if (!rivalPool) continue;

      pool.is_pvp = true;
      pool.pvp_risk = "high";
      pool.pvp_symbol = pool.base?.symbol || symbol;
      pool.pvp_rival_name = rival?.name || pool.pvp_symbol;
      pool.pvp_rival_mint = rival.id;
      pool.pvp_rival_pool = rivalPool.address;
      pool.pvp_rival_tvl = round(Number(rivalPool.tvl || 0));
      pool.pvp_rival_holders = rivalHolders;
      pool.pvp_rival_fees = Number(rivalFees.toFixed(2));
      log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.id.slice(0, 8)})`);
      break;
    }
  }));
}



/**
 * Refresh live metrics for discord-only signal pools.
 * Their discovery_pool is a snapshot from when the signal was captured — volume/volatility/fee
 * can be 0 even if the pool is active right now. We overwrite with fresh data from the
 * pool discovery API so filtering uses current numbers, not stale ones.
 */
async function refreshDiscordOnlyPools(pools, timeframe) {
  if (!pools.length) return;
  const FIELDS = ["volume", "fee", "active_tvl", "tvl", "volatility", "fee_active_tvl_ratio"];
  const results = await Promise.allSettled(
    pools.map((pool) =>
      fetchPoolDiscoveryDetail({ poolAddress: pool.pool_address, timeframe })
        .then((fresh) => ({ pool, fresh }))
    )
  );
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value.fresh) continue;
    const { pool, fresh } = result.value;
    for (const field of FIELDS) {
      const val = numeric(fresh[field]);
      if (val != null) pool[field] = val;
    }
    log("screening", `Discord signal refreshed live data: ${pool.name || pool.pool_address} — vol=${pool.volume?.toFixed(0)} fee=${pool.fee?.toFixed(2)}`);
  }
}

const GMGN_RECON_THROTTLE_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pick the highest-liquidity DLMM pool for a base mint from searchPools results.
 * Only considers pools where the mint is token_x (base side) and pool_type is dlmm
 * (inferred from bin_step presence — searchPools returns DLMM pools by default).
 * Returns the pool address + tvl, or null if no DLMM pool found.
 */
function pickBestDlmmPoolForMint(searchResult, mint) {
  if (!searchResult?.pools?.length || !mint) return null;
  const candidates = searchResult.pools.filter((p) => {
    const isBase = p.token_x?.mint === mint;
    const isDlmm = p.bin_step != null;
    return isBase && isDlmm && Number(p.tvl) > 0;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Number(b.tvl) - Number(a.tvl));
  return { pool_address: candidates[0].pool, tvl: Number(candidates[0].tvl) };
}

/**
 * GMGN trending candidate source — mirrors fetchDiscordSignalCandidates +
 * refreshDiscordOnlyPools. Fetches 1h-trending SOL tokens (≥ minVolume) from GMGN,
 * resolves each to its highest-liquidity Meteora DLMM pool via searchPools, then
 * fetches full 24h metrics via fetchPoolDiscoveryDetail so the pool passes through
 * the same hard-filter pipeline (getRawPoolScreeningRejectReason, enrichFee24hForPools,
 * cooldowns, blacklist, etc.) as Meteora-discovery pools.
 *
 * Returns [] on keyless / error / no candidates (non-blocking — caller falls back
 * to Meteora-discovery-only).
 */
async function fetchGmgnTrendingPools(timeframe) {
  const s = config.screening;
  const trending = await getGmgnTrending({
    chain: "sol",
    interval: s.gmgnTrendingInterval || "1h",
    minVolume: Number(s.gmgnTrendingMinVolume ?? 100_000),
    limit: Number(s.gmgnTrendingLimit ?? 20),
    orderBy: s.gmgnTrendingOrderBy || "volume",
  });
  if (trending.length === 0) {
    log("screening", "GMGN trending: no candidates returned");
    return [];
  }

  const resolved = [];
  let resolvedCount = 0;
  for (const token of trending) {
    if (!token.mint) continue;
    // Throttle to avoid 429s on the Meteora data API (matches the recon throttle
    // used in runScreeningCycle's per-candidate enrichment).
    if (resolved.length > 0) await sleep(GMGN_RECON_THROTTLE_MS);

    const searchResult = await searchPools({ query: token.mint, limit: 10 }).catch((error) => {
      log("screening", `GMGN searchPools failed for ${token.symbol || token.mint.slice(0, 8)}: ${error.message}`);
      return null;
    });
    const best = pickBestDlmmPoolForMint(searchResult, token.mint);
    if (!best) continue;
    resolvedCount++;

    // Fetch the full metric set (24h window) so getRawPoolScreeningRejectReason
    // has fee/volume/volatility/organic/holders/mcap/dev/launchpad to gate on.
    // This is the same call enrichFee24hForPools makes — stamping the 24h fields
    // directly so the fee/volume gates prefer them (enrichFee24hForPools short-
    // circuits pools that already have fee_24h + volume_24h).
    await sleep(GMGN_RECON_THROTTLE_MS);
    const detail = await fetchPoolDiscoveryDetail({
      poolAddress: best.pool_address,
      timeframe: "24h",
    }).catch((error) => {
      log("screening", `GMGN pool detail failed for ${token.symbol || best.pool_address.slice(0, 8)}: ${error.message}`);
      return null;
    });
    if (!detail) continue;

    // Stamp the 24h-window fields in the shape enrichFee24hForPools would have,
    // so the fee/volume gates evaluate against the real 24h window.
    if (Number.isFinite(Number(detail.fee)) && Number(detail.fee) > 0) detail.fee_24h = Number(detail.fee);
    if (Number.isFinite(Number(detail.volume)) && Number(detail.volume) > 0) detail.volume_24h = Number(detail.volume);
    if (Number.isFinite(Number(detail.fee_active_tvl_ratio)) && Number(detail.fee_active_tvl_ratio) > 0) {
      detail.fee_active_tvl_ratio_24h = Number(detail.fee_active_tvl_ratio);
    }
    // Mark origin + attach GMGN's own risk signals for the LLM (do NOT bypass
    // Meridian's on-chain gates — layered on top for visibility).
    detail.gmgn_trending = true;
    detail.gmgn_signals = {
      symbol: token.symbol,
      volume_interval: token.volume,
      liquidity_gmgn: token.liquidity,
      market_cap: token.market_cap,
      holder_count: token.holder_count,
      launchpad: token.launchpad,
      launchpad_platform: token.launchpad_platform,
      exchange: token.exchange,
      rug_ratio: token.rug_ratio,
      top_10_holder_rate: token.top_10_holder_rate,
      is_wash_trading: token.is_wash_trading,
      smart_degen_count: token.smart_degen_count,
      renowned_count: token.renowned_count,
      bundler_rate: token.bundler_rate,
      creator_token_status: token.creator_token_status,
      creator: token.creator,
      price_change_percent_1h: token.price_change_percent_1h,
      trending_rank: token.rank,
    };
    resolved.push(detail);
  }

  log("screening", `GMGN trending: fetched ${trending.length} candidate(s), resolved ${resolvedCount} to DLMM pool(s), ${resolved.length} enriched`);
  return resolved;
}

/**
 * Build the Meteora Pool Discovery API filter string for a given tier.
 * Degen = tight envelope (legacy). Midcap = loose ratio dust-floor on the API
 * (so fat-fee large pools pass the API), with the absolute-fee OR gate applied
 * post-fetch in getRawPoolScreeningRejectReason.
 */
function buildDiscoveryFilters(s, tier) {
  const isMidcap = tier === "midcap";
  const minMcap        = isMidcap ? (s.midcapMinMcap ?? s.minMcap)            : s.minMcap;
  const maxMcap        = isMidcap ? (s.midcapMaxMcap ?? s.maxMcap)            : s.maxMcap;
  const minHolders     = isMidcap ? (s.midcapMinHolders ?? s.minHolders)      : s.minHolders;
  const minTvl         = isMidcap ? (s.midcapMinTvl ?? s.minTvl)              : s.minTvl;
  const maxTvl         = isMidcap ? (s.midcapMaxTvl ?? s.maxTvl)              : s.maxTvl;
  const minBinStep     = isMidcap ? (s.midcapMinBinStep ?? s.minBinStep)      : s.minBinStep;
  const maxBinStep     = isMidcap ? (s.midcapMaxBinStep ?? s.maxBinStep)      : s.maxBinStep;
  const minOrganic     = isMidcap ? (s.midcapMinOrganic ?? s.minOrganic)      : s.minOrganic;
  const minQuoteOrganic = isMidcap ? (s.midcapMinOrganic ?? s.minQuoteOrganic): s.minQuoteOrganic;
  const maxTokenAgeHours = isMidcap ? (s.midcapMaxTokenAgeHours ?? s.maxTokenAgeHours) : s.maxTokenAgeHours;

  return [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    // NOTE: pool_type is NOT included here. The Meteora pool-discovery API does
    // not support comma-OR (`pool_type=dlmm,damm_v2` returns 0 pools). fetchTierPools
    // issues one fetch per pool_type (dlmm, damm_v2) and merges the results.
    `base_token_market_cap>=${minMcap}`,
    `base_token_market_cap<=${maxMcap}`,
    `base_token_holders>=${minHolders}`,
    // NOTE: volume>= and fee_active_tvl_ratio>= are NOT in the API filter string.
    // The configured screening timeframe (often 5m) reads volume=0 fee=0 on any
    // momentarily-quiet pool, and the API AND-filters server-side so a single
    // zero slice drops the pool entirely (TripleT-SOL was lost this way despite
    // $4K+ daily fees). Both gates run post-fetch in getRawPoolScreeningRejectReason
    // against the real 24h window enriched by enrichFee24hForPools.
    `tvl>=${minTvl}`,
    maxTvl != null ? `tvl<=${maxTvl}` : null,
    // dlmm_bin_step API filter dropped: it excludes DAMM v2 pools (no bin_step).
    // bin_step bounds are enforced in-code in getRawPoolScreeningRejectReason,
    // which is DLMM-only — DAMM pools hit the range gate there instead.
    `base_token_organic_score>=${minOrganic}`,
    `quote_token_organic_score>=${minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - maxTokenAgeHours * 3_600_000}` : null,
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");
}

/**
 * Fetch + volatility-normalize + threshold-filter pools for a single tier.
 * Returns { rawPools, filteredExamples, total } — rawPools are uncondensed.
 * Discord signals are merged only into the degen tier (they're degen-oriented).
 */
async function fetchTierPools(s, tier, page_size, { timeframe, category } = {}) {
  const tf = timeframe || s.timeframe;
  const cat = category || s.category;
  const filters = buildDiscoveryFilters(s, tier);
  // When GMGN trending is the only candidate source, skip the Meteora pool-discovery
  // fetch entirely (saves the API calls) — GMGN-sourced pools feed rawPools below.
  const gmgnOnly = tier === "degen" && config.screening.useGmgnTrending && config.screening.gmgnSignalMode === "only";
  // The pool-discovery API rejects comma-OR (`pool_type=dlmm,damm_v2` → 0 pools),
  // so fetch each pool_type separately and merge. Parallel to keep latency flat.
  const POOL_TYPES = ["dlmm", "damm_v2"];
  const pages = gmgnOnly ? [] : await Promise.all(
    POOL_TYPES.map((pt) =>
      fetchPoolDiscoveryPage({
        page_size,
        filters: `pool_type=${pt}&&${filters}`,
        timeframe: tf,
        category: cat,
      }).catch((error) => {
        log("screening", `${tier} pool_type=${pt} fetch failed: ${error.message}`);
        return { data: [] };
      })
    )
  );
  // Dedup by pool_address (a pool won't appear under both types, but be safe).
  const seen = new Set();
  let rawPools = [];
  for (const page of pages) {
    for (const pool of Array.isArray(page.data) ? page.data : []) {
      if (pool.pool_address && !seen.has(pool.pool_address)) {
        seen.add(pool.pool_address);
        rawPools.push(pool);
      }
    }
  }

  // GMGN trending candidate source (degen tier only, mirrors the Discord merge).
  if (tier === "degen" && config.screening.useGmgnTrending) {
    const gmgnPools = await fetchGmgnTrendingPools(tf).catch((error) => {
      log("screening", `GMGN trending fetch failed: ${error.message}`);
      return [];
    });
    if (config.screening.gmgnSignalMode === "only") {
      rawPools = gmgnPools;
    } else if (gmgnPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      for (const gmgnPool of gmgnPools) {
        if (!byPool.has(gmgnPool.pool_address)) byPool.set(gmgnPool.pool_address, gmgnPool);
      }
      rawPools = Array.from(byPool.values());
    }
  }

  // Discord signals only merge into the degen tier.
  if (tier === "degen" && config.screening.useDiscordSignals) {
    const signalCandidates = await fetchDiscordSignalCandidates().catch((error) => {
      log("screening", `Discord signal fetch failed: ${error.message}`);
      return [];
    });
    const signalPools = signalCandidates
      .map((candidate) => {
        const discoveryPool = candidate.discovery_pool;
        if (!discoveryPool?.pool_address) return null;
        return {
          ...discoveryPool,
          discord_signal: true,
          discord_signal_count: candidate.source_count || 1,
          discord_signal_seen_count: candidate.seen_count || 1,
          discord_signal_first_seen_at: candidate.first_seen_at || null,
          discord_signal_last_seen_at: candidate.last_seen_at || null,
        };
      })
      .filter(Boolean);

    if (config.screening.discordSignalMode === "only") {
      rawPools = signalPools;
      await refreshDiscordOnlyPools(rawPools, tf);
    } else if (signalPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      const discordOnlyPools = [];
      for (const signalPool of signalPools) {
        if (byPool.has(signalPool.pool_address)) {
          byPool.set(signalPool.pool_address, {
            ...byPool.get(signalPool.pool_address),
            discord_signal: true,
            discord_signal_count: signalPool.discord_signal_count,
            discord_signal_seen_count: signalPool.discord_signal_seen_count,
            discord_signal_first_seen_at: signalPool.discord_signal_first_seen_at,
            discord_signal_last_seen_at: signalPool.discord_signal_last_seen_at,
          });
        } else {
          byPool.set(signalPool.pool_address, signalPool);
          discordOnlyPools.push(signalPool);
        }
      }
      rawPools = Array.from(byPool.values());
      if (discordOnlyPools.length > 0) {
        await refreshDiscordOnlyPools(discordOnlyPools, tf);
      }
    }
  }

  rawPools = await applyVolatilityTimeframe(rawPools, tf);
  if (tier === "degen") await enrichDiscordSignalLaunchpads(rawPools);
  await enrichFee24hForPools(rawPools, s, tier);

  const filteredExamples = [];
  const thresholdedRawPools = rawPools.filter((pool) => {
    const reason = getRawPoolScreeningRejectReason(pool, s, tier);
    if (!reason) return true;
    filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason });
    if (pool.discord_signal) log("screening", `Discord signal filtered: ${pool.name || pool.pool_address} — ${reason}`);
    return false;
  });

  // Tag each surviving pool with the tier that admitted it.
  for (const pool of thresholdedRawPools) pool._tier = tier;

  return { rawPools: thresholdedRawPools, filteredExamples, total: rawPools.length };
}

/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Runs the degen tier always; if midcapEnabled, also runs the midcap tier and
 * merges by pool_address (degen tag wins on overlap). Returns condensed pools.
 */
export async function discoverPools({
  page_size = 50,
  timeframe,
  category,
} = {}) {
  const s = config.screening;

  const tiers = ["degen"];
  // In GMGN-only mode, GMGN trending is the sole candidate source and it only
  // feeds the degen tier. Running the midcap tier would leak Meteora-discovery
  // pools (gmgn_trending:false) through, defeating "only" mode. Skip it.
  const gmgnOnly = config.screening.useGmgnTrending && config.screening.gmgnSignalMode === "only";
  if (s.midcapEnabled && !gmgnOnly) tiers.push("midcap");

  const opts = { timeframe, category };
  const tierResults = await Promise.all(
    tiers.map((tier) => fetchTierPools(s, tier, page_size, opts).catch((error) => {
      log("screening", `${tier} tier discovery failed: ${error.message}`);
      return { rawPools: [], filteredExamples: [], total: 0 };
    }))
  );

  // Merge by pool_address. Degen wins on overlap (its filters are stricter, so a
  // pool that passes degen is the higher-conviction framing). Midcap-only pools
  // carry the midcap tag through to the candidate block.
  const byPool = new Map();
  const filteredExamples = [];
  let total = 0;
  for (let i = 0; i < tiers.length; i++) {
    const { rawPools, filteredExamples: tierEx, total: tierTotal } = tierResults[i];
    if (tierTotal > total) total = tierTotal;
    for (const ex of tierEx) filteredExamples.push(ex);
    for (const pool of rawPools) {
      if (!byPool.has(pool.pool_address)) byPool.set(pool.pool_address, pool);
    }
  }
  let rawPools = Array.from(byPool.values());

  const condensed = rawPools.map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total,
    pools,
    filtered_examples: filteredExamples,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const discovery = await discoverPools({ page_size: 50 });
  const { pools } = discovery;
  const filteredOut = Array.isArray(discovery.filtered_examples) ? [...discovery.filtered_examples] : [];

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  const s = config.screening;

  const eligible = pools
    .filter((p) => {
      const tier = p.tier || "degen";
      const isMidcap = tier === "midcap";
      // If this pool was admitted by an age band, that band's threshold
      // overrides apply here too (defense-in-depth re-check on the condensed
      // pool must use the same per-regime gates as pass one).
      const admittingBand = p.age_band
        ? (s.tokenAgeBands || []).find((b) => b.name === p.age_band)
        : null;
      const bandThresh = admittingBand?.thresholds || {};
      const tierMinTvl = isMidcap ? (s.midcapMinTvl ?? bandThresh.minTvl ?? s.minTvl) : (bandThresh.minTvl ?? s.minTvl);
      const tierMaxTvl = isMidcap ? (s.midcapMaxTvl ?? bandThresh.maxTvl ?? s.maxTvl) : (bandThresh.maxTvl ?? s.maxTvl);
      const tierFeeGateOpts = isMidcap
        ? { minFeeActiveTvlRatio: s.midcapMinFeeActiveTvlRatio ?? bandThresh.minFeeActiveTvlRatio ?? s.minFeeActiveTvlRatio, minFee24hUsd: s.midcapMinFee24hUsd ?? bandThresh.minFee24hUsd }
        : { minFeeActiveTvlRatio: bandThresh.minFeeActiveTvlRatio ?? s.minFeeActiveTvlRatio, minFee24hUsd: bandThresh.minFee24hUsd };
      const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
      if (Number.isFinite(tierMinTvl) && tierMinTvl > 0 && tvl < tierMinTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} below minTvl $${tierMinTvl} (${tier})`);
        return false;
      }
      if (Number.isFinite(tierMaxTvl) && tierMaxTvl > 0 && tvl > tierMaxTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} above maxTvl $${tierMaxTvl} (${tier})`);
        return false;
      }
      if (!passesFeeGate(p, tierFeeGateOpts)) {
        const ratio24h = Number(p?.fee_active_tvl_ratio_24h);
        const ratio = (Number.isFinite(ratio24h) && ratio24h > 0) ? ratio24h : (Number.isFinite(Number(p.fee_active_tvl_ratio)) ? p.fee_active_tvl_ratio : "unknown");
        const fee24h = estimateFee24hUsd(p);
        const floorStr = tierFeeGateOpts.minFee24hUsd != null ? ` OR fee_24h $${fee24h.toFixed(0)} < $${tierFeeGateOpts.minFee24hUsd}` : "";
        pushFilteredReason(filteredOut, p, `fee/active-TVL ${ratio} below ${tierFeeGateOpts.minFeeActiveTvlRatio}${floorStr} (${tier})`);
        return false;
      }
      if (!isUsableVolatility(p.volatility)) {
        pushFilteredReason(filteredOut, p, `volatility ${p.volatility ?? "unknown"} is unusable`);
        return false;
      }
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      return true;
    })
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, limit);

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => pushFilteredReason(filteredOut, p, "PVP hard filter"));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }

  // Dev blocklist check — filter pools whose creator is on the blocklist
  if (eligible.length > 0) {
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via dev blocklist`);
  }

  if (config.indicators.enabled && eligible.length > 0) {
    const bypassMidcap = config.screening.midcapBypassIndicators !== false;
    const confirmations = await Promise.all(
      eligible.map(async (pool) => {
        // Midcap entries are fee-yield plays, not momentum trades — skip the 5m
        // chart gate for them. Degen still requires confirmation.
        if (bypassMidcap && pool.tier === "midcap") {
          return {
            pool: pool.pool,
            confirmation: {
              enabled: true,
              confirmed: true,
              skipped: true,
              reason: "midcap tier bypasses indicator gate (fee-yield, not momentum)",
              intervals: [],
            },
          };
        }
        try {
          const confirmation = await confirmIndicatorPreset({
            mint: pool.base?.mint,
            side: "entry",
          });
          return { pool: pool.pool, confirmation };
        } catch (error) {
          return {
            pool: pool.pool,
            confirmation: {
              enabled: true,
              confirmed: true,
              skipped: true,
              reason: `Indicator confirmation unavailable: ${error.message}`,
              intervals: [],
            },
          };
        }
      }),
    );
    const confirmationByPool = new Map(confirmations.map((entry) => [entry.pool, entry.confirmation]));
    const before = eligible.length;
    const confirmedEligible = eligible.filter((pool) => {
      const confirmation = confirmationByPool.get(pool.pool);
      pool.indicator_confirmation = confirmation || null;
      if (!confirmation || confirmation.confirmed) return true;
      pushFilteredReason(filteredOut, pool, `indicator reject: ${confirmation.reason}`);
      log("screening", `Indicator rejected ${pool.name} (${pool.pool.slice(0, 8)}): ${confirmation.reason}`);
      return false;
    });
    eligible.splice(0, eligible.length, ...confirmedEligible);
    if (eligible.length < before) {
      log("screening", `Indicator confirmation removed ${before - eligible.length} candidate(s)`);
    }
  }

  return {
    candidates: eligible,
    total_screened: pools.length,
    filtered_examples: filteredOut.slice(0, 3),
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe });

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    tier: p._tier || "degen", // which screening tier admitted this pool
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,
    // DAMM v2 only: the pool's fixed price range (DAMM positions inherit it,
    // no per-position range). null for DLMM. Surfaces the range to the LLM so
    // it can pass downside_pct/upside_pct that fit within this envelope.
    price_range: p.pool_type === "damm_v2" ? {
      current: p.pool_price ?? null,
      min: p.min_price ?? null,
      max: p.max_price ?? null,
    } : null,

    // Core metrics (the numbers that matter)
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    fee_24h: round(p.fee_24h) ?? null, // real 24h fee (from enrichFee24hForPools)
    volume_window: round(p.volume),
    volume_24h: round(p.volume_24h) ?? null, // real 24h volume (from enrichFee24hForPools)
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    fee_active_tvl_ratio_24h: p.fee_active_tvl_ratio_24h != null ? fix(p.fee_active_tvl_ratio_24h, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),

    // Per-timeframe breakdown (populated when sourceTimeframe !== volatilityTimeframe)
    ...(p.volatility_timeframe && p.volatility_timeframe !== config.screening.timeframe ? {
      [`volume_${config.screening.timeframe}`]: round(p[`volume_${config.screening.timeframe}`] ?? null),
      [`volume_${p.volatility_timeframe}`]: round(p[`volume_${p.volatility_timeframe}`] ?? null),
      [`volatility_${config.screening.timeframe}`]: fix(p[`volatility_${config.screening.timeframe}`] ?? null, 4),
      [`volatility_${p.volatility_timeframe}`]: fix(p[`volatility_${p.volatility_timeframe}`] ?? null, 4),
    } : {}),

    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : (p._token_age_hours != null ? Math.floor(p._token_age_hours) : null),
    age_band: p._age_band || null,
    screening_profile: p._screening_profile || null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    discord_signal: Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count || 0,
    discord_signal_seen_count: p.discord_signal_seen_count || 0,
    discord_signal_last_seen_at: p.discord_signal_last_seen_at || null,

    // GMGN trending origin marker + GMGN's own risk signals (layered on top of
    // Meridian's on-chain gates for LLM visibility — do NOT bypass them).
    gmgn_trending: Boolean(p.gmgn_trending),
    gmgn_signals: p.gmgn_signals || null,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,

    // Liquidity-relative + LP-activity metrics (Degen Score inputs)
    volume_active_tvl_ratio: p.volume_active_tvl_ratio != null ? fix(p.volume_active_tvl_ratio, 4) : null,
    unique_lps: p.unique_lps,
    unique_lps_change_pct: fix(p.unique_lps_change_pct, 1),
    positions_created: p.positions_created,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = Number(n);
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}
