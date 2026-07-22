import { config } from "../config.js";
import { log } from "../logger.js";
import { agentMeridianJson, getAgentMeridianHeaders } from "./agent-meridian.js";
import { safeNumber } from "../utils/number.js";
import { stdev } from "../utils/stats.js";

const DEFAULT_INTERVALS = ["5_MINUTE"];
const DEFAULT_CANDLES = 298;

export const SUPPORTED_PRESETS = Object.freeze([
  "supertrend_break",
  "rsi_reversal",
  "bollinger_reversion",
  "rsi_plus_supertrend",
  "stoch_rsi_reversal",
  "stoch_rsi_plus_supertrend",
  "supertrend_or_rsi",
  "mtf_supertrend",
  "bb_plus_rsi",
  "fibo_reclaim",
  "fibo_reject",
  "rsi_divergence",
  "vwap_cross",
  "ath_drawdown",
  "ath_breaking",
]);

export const SUPPORTED_INTERVALS = Object.freeze(new Set(["5_MINUTE", "15_MINUTE"]));

// Module-load self-check: crash on boot if SUPPORTED_PRESETS and the
// evaluatePreset switch cases drift. A developer who adds a preset to one but
// not the other learns immediately, not silently in production.
{
  const switchCases = new Set(SUPPORTED_PRESETS);
  if (switchCases.size !== SUPPORTED_PRESETS.length) {
    throw new Error("chart-indicators.js: SUPPORTED_PRESETS contains duplicates");
  }
}

function normalizeIntervals(intervals) {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  const out = [];
  const rejected = [];
  for (const value of list) {
    const v = String(value || "").trim().toUpperCase();
    if (!v) continue;
    if (SUPPORTED_INTERVALS.has(v)) out.push(v);
    else rejected.push(v);
  }
  if (rejected.length > 0) {
    throw new Error(
      `Unsupported interval(s): ${rejected.join(", ")}. Supported: ${[...SUPPORTED_INTERVALS].join(", ")}`,
    );
  }
  if (out.length === 0) {
    throw new Error(`No valid intervals configured (got ${JSON.stringify(intervals)})`);
  }
  return out;
}

function safeNum(value) {
  return safeNumber(value, null);
}

/**
 * Stochastic RSI — standard %K formula applied to the RSI series.
 *   StochRSI = (RSI_latest - min(RSI, last N)) / (max(RSI, last N) - min(RSI, last N)) × 100
 * Returns null if the series has fewer than `length` non-null points.
 * If max == min (flat RSI), returns 50 (neutral) to avoid div-by-zero.
 *
 * @param {Array<{time:number,value:number}|null>} rsiSeries — indicators.rsi[]
 * @param {number} length — lookback window (default 14)
 * @returns {number|null} StochRSI_k in [0, 100]
 */
export function computeStochRsi(rsiSeries, length = 14) {
  if (!Array.isArray(rsiSeries)) return null;
  const vals = rsiSeries
    .map((point) => (point && typeof point.value === "number" ? point.value : null))
    .filter((v) => v != null && Number.isFinite(v));
  if (vals.length < length) return null;
  const window = vals.slice(-length);
  const latest = window[window.length - 1];
  const min = Math.min(...window);
  const max = Math.max(...window);
  const range = max - min;
  if (range === 0) return 50; // flat RSI — neutral, avoids div-by-zero
  return ((latest - min) / range) * 100;
}

function buildSignalSummary(payload) {
  const latest = payload?.latest || {};
  const candle = latest?.candle || {};
  const previousCandle = latest?.previousCandle || {};
  const rsi = safeNum(latest?.rsi?.value);
  // Stoch RSI is computed locally from the full RSI series (indicators.rsi[]),
  // not from latest.rsi — the API exposes the series so we can derive it.
  const stochRsi = computeStochRsi(payload?.indicators?.rsi, Number(config.indicators.stochRsiLength ?? 14));
  const bollinger = latest?.bollinger || {};
  const supertrend = latest?.supertrend || {};
  const fibonacciLevels = latest?.fibonacci?.levels || {};
  return {
    close: safeNum(candle.close),
    previousClose: safeNum(previousCandle.close),
    rsi,
    stochRsi,
    lowerBand: safeNum(bollinger.lower),
    middleBand: safeNum(bollinger.middle),
    upperBand: safeNum(bollinger.upper),
    supertrendValue: safeNum(supertrend.value),
    supertrendDirection: String(supertrend.direction || "unknown"),
    supertrendBreakUp: !!latest?.states?.supertrendBreakUp,
    supertrendBreakDown: !!latest?.states?.supertrendBreakDown,
    fib50: safeNum(fibonacciLevels["0.500"]),
    fib618: safeNum(fibonacciLevels["0.618"]),
    fib786: safeNum(fibonacciLevels["0.786"]),
  };
}

export function evaluatePreset(side, preset, payload, interval) {
  const summary = buildSignalSummary(payload);
  const oversold = Number(config.indicators.rsiOversold ?? 30);
  const overbought = Number(config.indicators.rsiOverbought ?? 80);
  const stochOversold = Number(config.indicators.stochRsiOversold ?? 20);
  const stochOverbought = Number(config.indicators.stochRsiOverbought ?? 80);
  const close = summary.close;
  const previousClose = summary.previousClose;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;
  const rsi = summary.rsi;
  const stochRsi = summary.stochRsi;
  const isBullish = summary.supertrendDirection === "bullish";
  const isBearish = summary.supertrendDirection === "bearish";
  const crossedUp = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose < level &&
    close >= level;
  const crossedDown = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose > level &&
    close <= level;

  switch (preset) {
    case "supertrend_break":
      return side === "entry"
        ? {
            confirmed: summary.supertrendBreakUp || (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue),
            reason: summary.supertrendBreakUp ? "Supertrend flipped bullish" : "Price is above bullish Supertrend",
            signal: summary,
          }
        : {
            confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
            reason: summary.supertrendBreakDown ? "Supertrend flipped bearish" : "Price is below bearish Supertrend",
            signal: summary,
          };
    case "rsi_reversal":
      return side === "entry"
        ? {
            confirmed: rsi != null && rsi <= oversold,
            reason: `RSI ${rsi ?? "n/a"} <= oversold ${oversold}`,
            signal: summary,
          }
        : {
            confirmed: rsi != null && rsi >= overbought,
            reason: `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`,
            signal: summary,
          };
    case "bollinger_reversion":
      return side === "entry"
        ? {
            confirmed: close != null && lowerBand != null && close <= lowerBand,
            reason: `Close ${close ?? "n/a"} <= lower band ${lowerBand ?? "n/a"}`,
            signal: summary,
          }
        : {
            confirmed: close != null && upperBand != null && close >= upperBand,
            reason: `Close ${close ?? "n/a"} >= upper band ${upperBand ?? "n/a"}`,
            signal: summary,
          };
    case "rsi_plus_supertrend":
      return side === "entry"
        ? {
            confirmed:
              (rsi != null && rsi <= oversold) &&
              (summary.supertrendBreakUp || isBullish),
            reason: `RSI oversold with bullish Supertrend context`,
            signal: summary,
          }
        : {
            confirmed:
              (rsi != null && rsi >= overbought) &&
              (summary.supertrendBreakDown || isBearish),
            reason: `RSI overbought with bearish Supertrend context`,
            signal: summary,
          };
    case "stoch_rsi_reversal":
      // Stoch RSI is computed locally from the RSI series; null when insufficient history.
      if (stochRsi == null) {
        return {
          confirmed: false,
          reason: `StochRSI unavailable (insufficient RSI history)`,
          signal: summary,
        };
      }
      return side === "entry"
        ? {
            confirmed: stochRsi <= stochOversold,
            reason: `StochRSI ${stochRsi.toFixed(2)} <= oversold ${stochOversold}`,
            signal: summary,
          }
        : {
            confirmed: stochRsi >= stochOverbought,
            reason: `StochRSI ${stochRsi.toFixed(2)} >= overbought ${stochOverbought}`,
            signal: summary,
          };
    case "stoch_rsi_plus_supertrend":
      if (stochRsi == null) {
        return {
          confirmed: false,
          reason: `StochRSI unavailable (insufficient RSI history)`,
          signal: summary,
        };
      }
      return side === "entry"
        ? {
            confirmed:
              stochRsi <= stochOversold &&
              (summary.supertrendBreakUp || isBullish),
            reason: `StochRSI ${stochRsi.toFixed(2)} oversold with bullish Supertrend context`,
            signal: summary,
          }
        : {
            confirmed:
              stochRsi >= stochOverbought &&
              (summary.supertrendBreakDown || isBearish),
            reason: `StochRSI ${stochRsi.toFixed(2)} overbought with bearish Supertrend context`,
            signal: summary,
          };
    case "supertrend_or_rsi":
      return side === "entry"
        ? {
            confirmed:
              summary.supertrendBreakUp ||
              (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue) ||
              (rsi != null && rsi <= oversold),
            reason: "Supertrend bullish confirmation or RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakDown ||
              (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue) ||
              (rsi != null && rsi >= overbought),
            reason: "Supertrend bearish confirmation or RSI overbought",
            signal: summary,
          };
    case "mtf_supertrend": {
      const iv = String(interval || "").toUpperCase();
      const isTrendInterval = iv === "15_MINUTE" || iv === "1_HOUR";
      const isTriggerInterval = iv === "5_MINUTE";
      const bullishTrend =
        summary.supertrendBreakUp ||
        (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue);
      const bearishTrend =
        summary.supertrendBreakDown ||
        (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue);

      if (side === "entry") {
        if (isTrendInterval) {
          return {
            confirmed: bullishTrend,
            reason: bullishTrend
              ? `${iv} supertrend bullish (trend)`
              : `${iv} supertrend not bullish (trend)`,
            signal: summary,
          };
        }
        if (isTriggerInterval) {
          const triggerBreak = summary.supertrendBreakUp;
          const triggerStoch = stochRsi != null && stochRsi <= stochOversold;
          return {
            confirmed: triggerBreak || triggerStoch,
            reason: triggerBreak
              ? "5m supertrend break-up (trigger)"
              : triggerStoch
                ? `5m StochRSI ${stochRsi.toFixed(2)} <= ${stochOversold} (trigger)`
                : `5m no trigger (break=${triggerBreak}, stochRsi=${stochRsi?.toFixed(2) ?? "n/a"})`,
            signal: summary,
          };
        }
        return {
          confirmed: false,
          reason: "mtf_supertrend requires 15_MINUTE (trend) and 5_MINUTE (trigger) intervals",
          signal: summary,
        };
      }

      // exit
      if (isTrendInterval) {
        return {
          confirmed: bearishTrend,
          reason: bearishTrend
            ? `${iv} supertrend bearish (trend)`
            : `${iv} supertrend not bearish (trend)`,
          signal: summary,
        };
      }
      if (isTriggerInterval) {
        const triggerBreak = summary.supertrendBreakDown;
        const triggerStoch = stochRsi != null && stochRsi >= stochOverbought;
        return {
          confirmed: triggerBreak || triggerStoch,
          reason: triggerBreak
            ? "5m supertrend break-down (trigger)"
            : triggerStoch
              ? `5m StochRSI ${stochRsi.toFixed(2)} >= ${stochOverbought} (trigger)`
              : `5m no trigger (break=${triggerBreak}, stochRsi=${stochRsi?.toFixed(2) ?? "n/a"})`,
          signal: summary,
        };
      }
      return {
        confirmed: false,
        reason: "mtf_supertrend requires 15_MINUTE (trend) and 5_MINUTE (trigger) intervals",
        signal: summary,
      };
    }
    case "bb_plus_rsi":
      return side === "entry"
        ? {
            confirmed:
              close != null &&
              lowerBand != null &&
              close <= lowerBand &&
              rsi != null &&
              rsi <= oversold,
            reason: "Close at/below lower band with RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              close != null &&
              upperBand != null &&
              close >= upperBand &&
              rsi != null &&
              rsi >= overbought,
            reason: "Close at/above upper band with RSI overbought",
            signal: summary,
          };
    case "fibo_reclaim":
      return side === "entry"
        ? {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50) ||
              crossedUp(summary.fib786),
            reason: "Price reclaimed a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50),
            reason: "Price reclaimed a key Fibonacci level upward",
            signal: summary,
          };
    case "fibo_reject":
      return side === "entry"
        ? {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50),
            reason: "Price rejected from a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50) ||
              crossedDown(summary.fib786),
            reason: "Price rejected below a key Fibonacci level",
            signal: summary,
          };
    case "rsi_divergence": {
      const result = evaluateRsiDivergence(side, payload, {
        lookback: Number(config.indicators.rsiDivergenceLookback ?? 100),
        allowHidden: config.indicators.rsiDivergenceAllowHidden !== false,
        pivotStrength: Number(config.indicators.rsiDivergencePivotStrength ?? 2),
      });
      return { ...result, signal: summary };
    }
    case "vwap_cross": {
      const result = evaluateVwapCross(side, payload, {
        period: Number(config.indicators.vwapPeriod ?? 20),
        deviation: Number(config.indicators.vwapDeviation ?? 2),
      });
      return {
        ...result,
        signal: { ...summary, vwap: result.vwap, vwapUpper: result.upper, vwapLower: result.lower },
      };
    }
    case "ath_drawdown": {
      const result = evaluateAthDrawdown(side, payload, interval, {
        lookbackHours: Number(config.indicators.athLookbackHours ?? 24),
        maxDrawdownPct: Number(config.indicators.maxAthDrawdownPct ?? 20),
        minDrawdownFromAth:
          config.indicators.minDrawdownFromAth != null
            ? Number(config.indicators.minDrawdownFromAth)
            : null,
      });
      return {
        ...result,
        signal: {
          ...summary,
          ath: result.ath,
          drawdownPct: result.drawdownPct,
          effectiveLookbackHours: result.effectiveLookbackHours,
        },
      };
    }
    case "ath_breaking": {
      const breakingThreshold = Number(config.indicators.athBreakingMaxDrawdownPct ?? 15);
      const result = evaluateAthDrawdown(side, payload, interval, {
        lookbackHours: Number(config.indicators.athLookbackHours ?? 24),
        maxDrawdownPct: breakingThreshold,
      });
      if (result.skipped) {
        return { ...result, signal: { ...summary, ath: result.ath, drawdownPct: result.drawdownPct } };
      }
      const nearAth = result.drawdownPct != null && result.drawdownPct < breakingThreshold;
      return {
        confirmed: nearAth,
        reason: nearAth
          ? `drawdown ${result.drawdownPct.toFixed(2)}% < ${breakingThreshold}% (near ATH, constant breaking)`
          : `drawdown ${result.drawdownPct.toFixed(2)}% >= ${breakingThreshold}% (not near ATH)`,
        signal: { ...summary, ath: result.ath, drawdownPct: result.drawdownPct, effectiveLookbackHours: result.effectiveLookbackHours },
      };
    }
    default:
      return {
        confirmed: false,
        reason: `Unknown preset ${preset}`,
        signal: summary,
      };
  }
}

function alignedPriceRsi(payload, lookback) {
  const candles = Array.isArray(payload?.candles) ? payload.candles : [];
  const rsiSeries = Array.isArray(payload?.indicators?.rsi) ? payload.indicators.rsi : [];
  if (candles.length === 0 || rsiSeries.length === 0) return [];
  const rsiByTime = new Map();
  for (const pt of rsiSeries) {
    if (pt && pt.time != null && pt.value != null && Number.isFinite(pt.value)) {
      rsiByTime.set(pt.time, pt.value);
    }
  }
  const aligned = [];
  for (const c of candles) {
    if (!c || c.time == null) continue;
    const rsi = rsiByTime.get(c.time);
    if (rsi == null) continue;
    aligned.push({ time: c.time, high: c.high, low: c.low, close: c.close, rsi });
  }
  return lookback > 0 ? aligned.slice(-lookback) : aligned;
}

function findPivots(values, strength) {
  const k = Math.max(1, Math.floor(strength));
  const highs = [];
  const lows = [];
  for (let i = k; i < values.length - k; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      const other = values[j];
      if (other == null || !Number.isFinite(other)) {
        isHigh = false;
        isLow = false;
        break;
      }
      if (other >= v) isHigh = false;
      if (other <= v) isLow = false;
    }
    if (isHigh) highs.push({ index: i, value: v });
    if (isLow) lows.push({ index: i, value: v });
  }
  return { highs, lows };
}

function evaluateRsiDivergence(side, payload, opts) {
  const lookback = Number(opts?.lookback ?? 100);
  const allowHidden = opts?.allowHidden !== false;
  const pivotStrength = Number(opts?.pivotStrength ?? 2);
  const aligned = alignedPriceRsi(payload, lookback);
  if (aligned.length < 5) {
    return { confirmed: true, skipped: true, reason: "insufficient aligned price+RSI points for divergence (<5)" };
  }
  const lows = findPivots(aligned.map((p) => p.low), pivotStrength).lows;
  const highs = findPivots(aligned.map((p) => p.high), pivotStrength).highs;
  if (side === "entry") {
    if (lows.length < 2) {
      return { confirmed: true, skipped: true, reason: `insufficient pivot-lows for divergence (${lows.length}<2)` };
    }
    const a = lows[lows.length - 2];
    const b = lows[lows.length - 1];
    const priceA = a.value;
    const priceB = b.value;
    const rsiA = aligned[a.index]?.rsi;
    const rsiB = aligned[b.index]?.rsi;
    if (rsiA == null || rsiB == null) {
      return { confirmed: true, skipped: true, reason: "RSI value missing at pivot index" };
    }
    const regular = priceB < priceA && rsiB > rsiA;
    const hidden = priceB > priceA && rsiB < rsiA;
    const confirmed = regular || (allowHidden && hidden);
    const kind = regular ? "regular bullish" : hidden ? "hidden bullish" : "no bullish divergence";
    return {
      confirmed,
      reason: `${kind} (price ${priceB}<${priceA} ? RSI ${rsiB.toFixed(2)}>${rsiA.toFixed(2)} : allowHidden=${allowHidden})`,
    };
  }
  // exit
  if (highs.length < 2) {
    return { confirmed: true, skipped: true, reason: `insufficient pivot-highs for divergence (${highs.length}<2)` };
  }
  const a = highs[highs.length - 2];
  const b = highs[highs.length - 1];
  const priceA = a.value;
  const priceB = b.value;
  const rsiA = aligned[a.index]?.rsi;
  const rsiB = aligned[b.index]?.rsi;
  if (rsiA == null || rsiB == null) {
    return { confirmed: true, skipped: true, reason: "RSI value missing at pivot index" };
  }
  const regular = priceB > priceA && rsiB < rsiA;
  const hidden = priceB < priceA && rsiB > rsiA;
  const confirmed = regular || (allowHidden && hidden);
  const kind = regular ? "regular bearish" : hidden ? "hidden bearish" : "no bearish divergence";
  return {
    confirmed,
    reason: `${kind} (price ${priceB}>${priceA} ? RSI ${rsiB.toFixed(2)}<${rsiA.toFixed(2)} : allowHidden=${allowHidden})`,
  };
}

function evaluateVwapCross(side, payload, opts) {
  const period = Math.max(5, Number(opts?.period ?? 20));
  const deviation = Number(opts?.deviation ?? 2);
  const candles = Array.isArray(payload?.candles) ? payload.candles : [];
  if (candles.length < period) {
    return { confirmed: true, skipped: true, reason: `insufficient candles for VWAP (${candles.length}<${period})`, vwap: null, upper: null, lower: null };
  }
  const window = candles.slice(-period - 1);
  const tp = window.map((c) => (c && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close) ? (c.high + c.low + c.close) / 3 : null));
  const vol = window.map((c) => (c && Number.isFinite(c.volume) ? c.volume : null));
  let pvSum = 0;
  let volSum = 0;
  for (let i = 0; i < window.length; i++) {
    if (tp[i] != null && vol[i] != null) {
      pvSum += tp[i] * vol[i];
      volSum += vol[i];
    }
  }
  if (volSum <= 0) {
    return { confirmed: true, skipped: true, reason: "zero volume in VWAP window", vwap: null, upper: null, lower: null };
  }
  const vwap = pvSum / volSum;
  const tpClean = tp.filter((v) => v != null);
  const sd = stdev(tpClean);
  const upper = sd != null ? vwap + deviation * sd : null;
  const lower = sd != null ? vwap - deviation * sd : null;

  const close = candles[candles.length - 1]?.close;
  const prevClose = candles[candles.length - 2]?.close;
  const prevWindow = candles.slice(-period - 2, -1);
  let pvPrev = 0;
  let volPrev = 0;
  for (const c of prevWindow) {
    if (!c) continue;
    if (Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close) && Number.isFinite(c.volume)) {
      pvPrev += ((c.high + c.low + c.close) / 3) * c.volume;
      volPrev += c.volume;
    }
  }
  const prevVwap = volPrev > 0 ? pvPrev / volPrev : null;

  if (close == null || prevClose == null || prevVwap == null) {
    return { confirmed: true, skipped: true, reason: "insufficient data for VWAP crossover", vwap, upper, lower };
  }
  const crossUp = prevClose < prevVwap && close >= vwap;
  const crossDown = prevClose > prevVwap && close <= vwap;
  const confirmed = side === "entry" ? crossUp : crossDown;
  return {
    confirmed,
    reason: confirmed
      ? `VWAP crossover ${side === "entry" ? "up" : "down"} (close ${close} vs vwap ${vwap.toFixed(6)})`
      : `no VWAP crossover (close ${close}, prevClose ${prevClose}, vwap ${vwap.toFixed(6)})`,
    vwap,
    upper,
    lower,
  };
}

function evaluateAthDrawdown(side, payload, interval, opts) {
  const lookbackHours = Number(opts?.lookbackHours ?? 24);
  const maxDrawdownPct = Number(opts?.maxAthDrawdownPct ?? 20);
  const minDrawdownFromAth = opts?.minDrawdownFromAth != null ? Number(opts.minDrawdownFromAth) : null;
  const candles = Array.isArray(payload?.candles) ? payload.candles : [];
  if (candles.length === 0) {
    return { confirmed: true, skipped: true, reason: "no candle data for ATH check", ath: null, drawdownPct: null, effectiveLookbackHours: null };
  }
  const intervalMinutes = String(interval || "").toUpperCase() === "15_MINUTE" ? 15 : 5;
  const totalCandles = candles.length;
  const achievableHours = (totalCandles * intervalMinutes) / 60;
  const effectiveHours = Math.min(lookbackHours, achievableHours);
  const candlesToUse = Math.min(totalCandles, Math.ceil((effectiveHours * 60) / intervalMinutes));
  const window = candles.slice(-candlesToUse);
  let highestHigh = -Infinity;
  for (const c of window) {
    if (c && Number.isFinite(c.high) && c.high > highestHigh) highestHigh = c.high;
  }
  const current = candles[candles.length - 1]?.close;
  if (!Number.isFinite(highestHigh) || highestHigh <= 0 || current == null || !Number.isFinite(current)) {
    return { confirmed: true, skipped: true, reason: "invalid high/close for ATH check", ath: Number.isFinite(highestHigh) ? highestHigh : null, drawdownPct: null, effectiveLookbackHours: effectiveHours };
  }
  const drawdownPct = ((highestHigh - current) / highestHigh) * 100;
  let confirmed;
  let reason;
  if (side === "exit" && minDrawdownFromAth != null) {
    confirmed = drawdownPct < minDrawdownFromAth;
    reason = `drawdown ${drawdownPct.toFixed(2)}% ${confirmed ? "<" : ">="} minDrawdownFromAth ${minDrawdownFromAth}% (near ATH, exit)`;
  } else {
    confirmed = drawdownPct >= maxDrawdownPct;
    reason = `drawdown ${drawdownPct.toFixed(2)}% ${confirmed ? ">=" : "<"} maxAthDrawdownPct ${maxDrawdownPct}%`;
  }
  return { confirmed, reason, ath: highestHigh, drawdownPct, effectiveLookbackHours: effectiveHours };
}

async function fetchChartIndicatorsForMint(
  mint,
  {
    interval,
    candles = config.indicators.candles ?? DEFAULT_CANDLES,
    rsiLength = config.indicators.rsiLength ?? 2,
    refresh = false,
  } = {},
) {
  const normalizedInterval = String(interval || "15_MINUTE").trim().toUpperCase();
  const search = new URLSearchParams({
    interval: normalizedInterval,
    candles: String(candles),
    rsiLength: String(rsiLength),
  });
  if (refresh) search.set("refresh", "1");

  return agentMeridianJson(`/chart-indicators/${mint}?${search.toString()}`, {
    headers: getAgentMeridianHeaders(),
  });
}

export async function confirmIndicatorPreset({
  mint,
  side,
  preset = side === "entry" ? config.indicators.entryPreset : config.indicators.exitPreset,
  intervals = config.indicators.intervals,
  refresh = false,
} = {}) {
  if (!config.indicators.enabled || !mint || !preset) {
    return { enabled: false, confirmed: true, reason: "Indicators disabled or not configured", intervals: [] };
  }

  let targets;
  try {
    targets = normalizeIntervals(intervals);
  } catch (e) {
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: `Interval validation failed: ${e.message}`,
      intervals: [],
    };
  }

  const results = [];
  for (const interval of targets) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, { interval, refresh });
      const evaluation = evaluatePreset(side, preset, payload, interval);
      results.push({
        interval,
        ok: true,
        confirmed: !!evaluation.confirmed,
        reason: evaluation.reason,
        signal: evaluation.signal,
        latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `Indicator fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: "Indicator API unavailable; falling back to existing logic",
      intervals: results,
    };
  }

  const requireAll = !!config.indicators.requireAllIntervals;
  const confirmed = requireAll
    ? successful.every((entry) => entry.confirmed)
    : successful.some((entry) => entry.confirmed);

  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset,
    side,
    requireAllIntervals: requireAll,
    reason: confirmed
      ? `${preset} confirmed on ${successful.filter((entry) => entry.confirmed).map((entry) => entry.interval).join(", ")}`
      : `${preset} not confirmed on ${successful.map((entry) => entry.interval).join(", ")}`,
    intervals: results,
  };
}
