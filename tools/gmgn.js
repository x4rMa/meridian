import { randomUUID } from "crypto";
import { setDefaultResultOrder } from "dns";
import { config } from "../config.js";
import { log } from "../logger.js";

// Force IPv4 — GMGN OpenAPI does not support IPv6
setDefaultResultOrder("ipv4first");

let lastGmgnRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceGmgnRequest() {
  const delayMs = Math.max(0, Number(config.gmgn?.requestDelayMs ?? 2500));
  if (!delayMs) return;
  const elapsed = Date.now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = Date.now();
}

function getApiKey() {
  const key = config.gmgn?.apiKey || process.env.GMGN_API_KEY;
  if (!key) throw new Error("GMGN_API_KEY is required for the GMGN fee source.");
  return key;
}

export function hasGmgnApiKey() {
  return !!(config.gmgn?.apiKey || process.env.GMGN_API_KEY);
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter((item) => item != null && item !== "")) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(pathname, { method = "GET", params = {}, body = null } = {}) {
  const baseUrl = String(config.gmgn?.baseUrl || "https://openapi.gmgn.ai").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${pathname}`);
  appendParams(url, {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  });

  const maxRetries = Math.max(0, Number(config.gmgn?.maxRetries ?? 2));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceGmgnRequest();
    const res = await fetch(url, {
      method,
      headers: {
        "X-APIKEY": getApiKey(),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : null,
    });
    const text = await res.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    const message = payload?.message || payload?.error || payload?.raw || `GMGN ${pathname} ${res.status}`;
    const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
    if (res.ok) return payload;
    if (rateLimited && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : /temporarily banned/i.test(String(message))
          ? 60000
          : Math.min(30000, 3000 * Math.pow(2, attempt));
      await sleep(backoffMs);
      continue;
    }
    throw new Error(message);
  }
  throw new Error(`GMGN ${pathname} failed`);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ─── Token fees (SOL) for the minTokenFeesSol gate ──────────────
// Returns { total_fee, trade_fee } in SOL, or null on missing key / error
// so callers can fall back to Jupiter's fee figure.
export async function getGmgnTokenFees(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  try {
    const payload = await gmgnFetch("/v1/token/info", { params: { chain: "sol", address: mint } });
    const info = payload?.data?.data || payload?.data || payload;
    if (!info || typeof info !== "object") return null;
    return {
      total_fee: num(info.total_fee),
      trade_fee: num(info.trade_fee),
    };
  } catch (error) {
    log("gmgn", `token fees lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}

// ─── Trending tokens (candidate source for screening) ──────────
// GET /v1/market/rank — trending tokens ranked by swap activity over a window.
// Returns mapped rank items with the fields the screener needs to resolve a
// Meteora DLMM pool and assess risk. Keyless / error → [] (non-blocking).
const DEFAULT_TRENDING_FILTERS_SOL = ["renounced", "frozen"];

export async function getGmgnTrending({
  chain = "sol",
  interval = "1h",
  minVolume = 100_000,
  limit = 50,
  orderBy = "volume",
  filters,
  platforms = [],
} = {}) {
  if (!hasGmgnApiKey()) {
    log("gmgn", "trending skipped: no API key");
    return [];
  }
  // SOL chains default to renounced+frozen safety filters (matching gmgn-cli's
  // documented chain defaults). Pass an explicit [] to disable.
  const resolvedFilters = filters === undefined && chain === "sol"
    ? DEFAULT_TRENDING_FILTERS_SOL
    : (filters || []);
  try {
    const payload = await gmgnFetch("/v1/market/rank", {
      params: {
        chain,
        interval,
        order_by: orderBy,
        limit,
        min_volume: minVolume,
        filters: resolvedFilters,
        platforms,
      },
    });
    // Response envelope is { code, data: { code, data: { rank: [...] } } } —
    // the OpenAPI wraps the upstream rank payload in a second `data` layer.
    const rank = payload?.data?.data?.rank || payload?.data?.rank || payload?.rank || [];
    if (!Array.isArray(rank)) return [];
    return rank.map((item) => ({
      mint: item.address,
      symbol: item.symbol,
      name: item.name,
      chain: item.chain || chain,
      volume: num(item.volume),
      liquidity: num(item.liquidity),
      market_cap: num(item.market_cap),
      holder_count: num(item.holder_count),
      launchpad: item.launchpad || null,
      launchpad_platform: item.launchpad_platform || null,
      exchange: item.exchange || null,
      // Risk signals — layered onto the pool as gmgn_signals (do NOT bypass
      // Meridian's on-chain gates; for the LLM to see).
      rug_ratio: num(item.rug_ratio),
      top_10_holder_rate: num(item.top_10_holder_rate),
      is_wash_trading: Boolean(item.is_wash_trading),
      smart_degen_count: num(item.smart_degen_count),
      renowned_count: num(item.renowned_count),
      bundler_rate: num(item.bundler_rate),
      creator_token_status: item.creator_token_status || null,
      creator: item.creator || null,
      price: num(item.price),
      price_change_percent_1h: num(item.price_change_percent1h),
      rank: num(item.rank),
    }));
  } catch (error) {
    log("gmgn", `trending fetch failed: ${error.message}`);
    return [];
  }
}
