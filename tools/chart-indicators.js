import { config } from "../config.js";
import { log } from "../logger.js";
import { agentMeridianJson, getAgentMeridianHeaders } from "./agent-meridian.js";
import { safeNumber } from "../utils/number.js";

const DEFAULT_INTERVALS = ["5_MINUTE"];
const DEFAULT_CANDLES = 298;

function normalizeIntervals(intervals) {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  return list
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => value === "5_MINUTE" || value === "15_MINUTE");
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
    default:
      return {
        confirmed: false,
        reason: `Unknown preset ${preset}`,
        signal: summary,
      };
  }
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

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return { enabled: false, confirmed: true, reason: "No indicator intervals configured", intervals: [] };
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
