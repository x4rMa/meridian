import { SUPPORTED_PRESETS, SUPPORTED_INTERVALS } from "./tools/chart-indicators.js";

// Exhaustive set of flat top-level keys read from `u.*` in config.js (verified by
// enumeration). Includes env-passthrough keys and aliases (emergencyPriceDropPct,
// takeProfitFeePct, binsBelow) so legacy configs don't false-warn. Any top-level
// key in user-config.json not in this set is reported as an unused-config-key
// warning. Nested keys under `chartIndicators.*` are NOT checked here — their
// valid set changes as presets are added, and validating it would recreate the
// drift trap this module exists to prevent.
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "maxPositions", "maxDeployAmount",
  "excludeHighSupplyConcentration", "minFeeActiveTvlRatio", "minTvl", "maxTvl",
  "minVolume", "minOrganic", "minQuoteOrganic", "minHolders", "minMcap", "maxMcap",
  "minBinStep", "maxBinStep", "timeframe", "category", "minTokenFeesSol",
  "useDiscordSignals", "discordSignalMode", "useGmgnTrending", "gmgnSignalMode",
  "gmgnTrendingInterval", "gmgnTrendingMinVolume", "gmgnTrendingLimit",
  "gmgnTrendingOrderBy", "avoidPvpSymbols", "blockPvpSymbols", "maxBotHoldersPct",
  "maxTop10Pct", "loneCandidateMinDegen", "allowedLaunchpads", "blockedLaunchpads",
  "minTokenAgeHours", "maxTokenAgeHours", "tokenAgeBands", "minDrawdownFromAthPct",
  "requireVolumeAccelerating", "midcapEnabled", "midcapMaxTvl",
  "midcapMaxTokenAgeHours", "midcapMinBinStep", "midcapMaxBinStep",
  "midcapMinFeeActiveTvlRatio", "midcapMinFee24hUsd", "midcapMinOrganic",
  "midcapMinHolders", "midcapMinMcap", "midcapMaxMcap", "midcapMinTvl",
  "midcapBypassIndicators", "midcapBypassTimingFilters", "dammMinDownsidePct",
  "dammMinUpsidePct",
  "minClaimAmount", "autoSwapAfterClaim", "autoSwapRetryAttempts",
  "autoSwapRetryDelayMs", "outOfRangeBinsToClose", "outOfRangeWaitMinutes",
  "oorCooldownTriggerCount", "oorCooldownHours", "repeatDeployCooldownEnabled",
  "repeatDeployCooldownTriggerCount", "repeatDeployCooldownHours",
  "repeatDeployCooldownScope", "repeatDeployCooldownMinFeeEarnedPct",
  "repeatDeployCooldownMinFeeYieldPct", "minVolumeToRebalance", "stopLossPct",
  "emergencyPriceDropPct", "takeProfitPct", "takeProfitFeePct", "minFeePerTvl24h",
  "minAgeBeforeYieldCheck", "minSolToOpen", "deployAmountSol", "gasReserve",
  "positionSizePct", "trailingTakeProfit", "trailingTriggerPct", "trailingDropPct",
  "pnlSanityMaxDiffPct", "solMode", "enableDammDeploy", "strategy", "binsBelow",
  "minBinsBelow", "maxBinsBelow", "defaultBinsBelow", "managementIntervalMin",
  "screeningIntervalMin", "healthCheckIntervalMin", "temperature", "maxTokens",
  "maxSteps", "managementModel", "screeningModel", "generalModel",
  "darwinEnabled", "darwinWindowDays", "darwinRecalcEvery", "darwinBoost",
  "darwinDecay", "darwinFloor", "darwinCeiling", "darwinMinSamples",
  "hiveMindUrl", "hiveMindApiKey", "agentId", "hiveMindPullMode",
  "agentMeridianApiUrl", "publicApiKey", "lpAgentRelayEnabled",
  "pnlRpcUrl", "pnlSource", "pnlPollIntervalSec", "pnlDepositCacheTtlSec",
  "pnlConfirmTicks", "opportunityPollEnabled", "opportunityPollIntervalSec",
  "opportunityPollLimit", "opportunityMinScore", "opportunitySmartWalletBonus",
  "degenTargetVolRatio", "degenTargetLpCount", "degenTargetFeeRatio",
  "degenTargetLiquidity", "gmgnApiKey", "gmgnBaseUrl", "gmgnRequestDelayMs",
  "gmgnMaxRetries", "gmgnFeeSource", "markovEnabled", "markovWindowMinutes",
  "markovThresholdPct", "chartIndicators",
  "rpcUrl", "walletKey", "llmModel", "llmBaseUrl", "llmApiKey", "dryRun",
  "telegramChatId",
]);

// Keys present in user-config.json for operational reasons (timestamps, file
// markers) that are not read by config.js but should not trigger warnings.
const NON_WARNING_KEYS = new Set(["_lastAgentTune", "preset"]);

/**
 * Validate a candidate config object.
 *
 * @param {object} candidate - the post-defaults config object the app would run with.
 * @param {object} [rawUserConfig] - raw user-config.json object, used only for the
 *   unused-top-level-key warning (we need the raw keys as the user wrote them,
 *   not the post-defaults config which has every key filled in).
 * @returns {{ok:boolean, fatal:string[], warnings:string[]}}
 *   - ok=false ⇔ fatal.length > 0 ⇔ caller MUST refuse to boot / refuse to write.
 *   - warnings is informational; caller logs but proceeds.
 */
export function validateConfig(candidate, rawUserConfig) {
  const fatal = [];
  const warnings = [];

  const indicators = candidate?.indicators ?? {};

  // Fatal: unknown entryPreset
  if (!SUPPORTED_PRESETS.includes(indicators.entryPreset)) {
    fatal.push(`Unknown entryPreset: "${indicators.entryPreset}"`);
    fatal.push(`Supported presets: ${SUPPORTED_PRESETS.join(", ")}`);
  }

  // Fatal: unknown exitPreset
  if (!SUPPORTED_PRESETS.includes(indicators.exitPreset)) {
    fatal.push(`Unknown exitPreset: "${indicators.exitPreset}"`);
    fatal.push(`Supported presets: ${SUPPORTED_PRESETS.join(", ")}`);
  }

  // Fatal: unsupported interval
  const intervals = indicators.intervals;
  if (!Array.isArray(intervals) || intervals.length === 0) {
    fatal.push("indicators.intervals must be a non-empty array");
  } else {
    const bad = intervals.filter((i) => !SUPPORTED_INTERVALS.has(i));
    if (bad.length > 0) {
      fatal.push(`Unsupported interval(s): ${bad.join(", ")}`);
      fatal.push(`Supported intervals: ${[...SUPPORTED_INTERVALS].join(", ")}`);
    }
  }

  // Warn: athLookbackHours exceeds achievable candle window
  const candles = Number(indicators.candles ?? 298);
  const requestedH = Number(indicators.athLookbackHours ?? 24);
  if (Array.isArray(intervals)) {
    for (const iv of intervals) {
      const mins = iv === "15_MINUTE" ? 15 : 5;
      const achievableH = (candles * mins) / 60;
      if (requestedH > achievableH) {
        warnings.push(
          `athLookbackHours=${requestedH} exceeds achievable window (${achievableH.toFixed(1)}h at ${iv}/${candles} candles). Will cap at runtime.`,
        );
      }
    }
  }

  // Warn: maxAthDrawdownPct and minDrawdownFromAth both set (mutually exclusive)
  if (indicators.maxAthDrawdownPct != null && indicators.minDrawdownFromAth != null) {
    warnings.push(
      `Both maxAthDrawdownPct and minDrawdownFromAth are set; they are mutually exclusive (entry vs exit semantics). ath_drawdown will use minDrawdownFromAth for exit only.`,
    );
  }

  // Warn: unrecognized top-level keys in raw user-config
  if (rawUserConfig && typeof rawUserConfig === "object" && !Array.isArray(rawUserConfig)) {
    const unknown = Object.keys(rawUserConfig).filter(
      (k) => !KNOWN_TOP_LEVEL_KEYS.has(k) && !NON_WARNING_KEYS.has(k),
    );
    if (unknown.length > 0) {
      warnings.push(`Unused config keys: ${unknown.join(", ")}`);
    }
  }

  return { ok: fatal.length === 0, fatal, warnings };
}
