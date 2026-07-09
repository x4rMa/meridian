#!/usr/bin/env node
/**
 * sweep-residue.js — convert residual SPL tokens back to SOL.
 *
 * Runs standalone (system cron / PM2 cron). Enumerates every SPL token the
 * wallet holds via direct RPC (no HELIUS_API_KEY required) and swaps each to
 * SOL via Jupiter, skipping only SOL / wrapped SOL.
 *
 * USD floor (default $0.10, matches auto-swap-on-close) only applies when
 * HELIUS_API_KEY is set — without it, USD values are unknown so every
 * non-zero balance is swept (pricing is a sanity gate, not a blocker).
 *
 * Each token gets retries (Jupiter can transiently fail with no route).
 *
 * Usage:
 *   node scripts/sweep-residue.js                # sweep, $0.10 floor (if Helius)
 *   node scripts/sweep-residue.js --dry-run      # report only, no swaps
 *   node scripts/sweep-residue.js --floor 1.00   # only tokens worth >= $1
 *
 * Suggested cron (every 24h at 03:17 local — off-hour to avoid screening cycles):
 *   17 3 * * *  cd /home/mbahyo/meridian && /usr/bin/node scripts/sweep-residue.js >> logs/sweep.log 2>&1
 */

import { loadEnv } from "../envcrypt.js";
import fs from "fs";
import os from "os";
import path from "path";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

import { config } from "../config.js";
import { log } from "../logger.js";
import { swapToken, getTokenBalance } from "../tools/wallet.js";

// ─── Flag parsing ────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || process.env.DRY_RUN === "true";
const floorIdx = args.indexOf("--floor");
const floorArg = floorIdx >= 0 ? parseFloat(args[floorIdx + 1]) : NaN;
const USD_FLOOR = Number.isFinite(floorArg) ? floorArg : 0.10;

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

// SOL variants — already SOL, never swapped to themselves.
const SKIP_MINTS = new Set([
  config.tokens.SOL,
  "So11111111111111111111111111111111111111112", // wrapped SOL
].filter(Boolean));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

let _conn = null;
function getConnection() {
  if (!_conn) _conn = new Connection(process.env.RPC_URL, "confirmed");
  return _conn;
}

/**
 * Enumerate every SPL token the wallet holds with a >0 balance, via direct RPC
 * (Helius-free). Works without HELIUS_API_KEY — getWalletBalances returns an
 * empty token list when Helius isn't configured, which would silently hide all
 * residue from the sweep.
 * Returns [{ mint, symbol, balance, decimals }] in UI units.
 */
async function enumerateWalletTokens(walletPubkey) {
  const conn = getConnection();
  const [legacy, t22] = await Promise.allSettled([
    conn.getParsedTokenAccountsByOwner(walletPubkey, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(walletPubkey, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const accounts = [
    ...(legacy.status === "fulfilled" ? legacy.value.value : []),
    ...(t22.status === "fulfilled" ? t22.value.value : []),
  ];
  const out = [];
  for (const acc of accounts) {
    const info = acc.account.data?.parsed?.info;
    if (!info) continue;
    const decimals = info.tokenAmount?.decimals ?? 6;
    const amount = Number(info.tokenAmount?.amount ?? 0) / Math.pow(10, decimals);
    if (amount > 0) {
      out.push({ mint: info.mint, symbol: info.symbol || info.mint.slice(0, 6), balance: amount, decimals });
    }
  }
  return out;
}

async function getWalletPubkey() {
  const bs58 = (await import("bs58")).default;
  const { Keypair } = await import("@solana/web3.js");
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
  return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey;
}

// ─── .env resolution: MERIDIAN_HOME → ~/.meridian → repo ─────────
if (!process.env.MERIDIAN_HOME && fs.existsSync(path.join(os.homedir(), ".meridian", ".env"))) {
  const meridianDir = path.join(os.homedir(), ".meridian");
  loadEnv({
    envPath: path.join(meridianDir, ".env"),
    keyPath: path.join(meridianDir, ".envrypt"),
    override: false,
  });
}

function shortMint(mint) {
  return mint ? `${mint.slice(0, 8)}…${mint.slice(-4)}` : "?";
}

async function sweepToken(token) {
  // Re-read the raw on-chain balance each attempt — amounts can shift on
  // partial fills, and a token may already be gone if a prior swap landed.
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const bal = await getTokenBalance(token.mint);
      if (!bal || !bal.balance || bal.balance <= 0) {
        return { mint: token.mint, symbol: token.symbol, swapped: attempt > 1, amount: 0 };
      }
      const usdTag = token.usd != null ? ` ($${token.usd.toFixed(2)})` : "";
      log("sweep", `Swapping ${token.symbol} ${shortMint(token.mint)}${usdTag} → SOL (attempt ${attempt}/${MAX_ATTEMPTS})`);
      if (dryRun) {
        return { mint: token.mint, symbol: token.symbol, swapped: false, dry_run: true, would_swap: bal.balance };
      }
      const res = await swapToken({ input_mint: token.mint, output_mint: "SOL", amount: bal.balance });
      const ok = res && res.success !== false && !res.error && (res.tx || res.amount_out);
      if (ok) {
        return {
          mint: token.mint,
          symbol: token.symbol,
          swapped: true,
          amount_in: bal.balance,
          amount_out: res.amount_out,
          tx: res.tx,
        };
      }
      lastErr = res?.error || res?.reason || "swap returned no tx";
    } catch (e) {
      lastErr = e.message;
    }
    log("sweep_warn", `Attempt ${attempt}/${MAX_ATTEMPTS} for ${token.symbol} failed: ${lastErr}`);
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  return { mint: token.mint, symbol: token.symbol, swapped: false, error: lastErr };
}

async function main() {
  const startedAt = new Date().toISOString();
  log("sweep", `Sweep started at ${startedAt} (floor=$${USD_FLOOR}, dryRun=${dryRun})`);

  let walletPubkey;
  try {
    walletPubkey = await getWalletPubkey();
  } catch (e) {
    log("sweep_error", e.message);
    console.error(JSON.stringify({ error: e.message }));
    process.exit(1);
  }

  const tokens = (await enumerateWalletTokens(walletPubkey)).filter(
    (t) => t.mint && !SKIP_MINTS.has(t.mint),
  );

  // Optional USD floor: only applies when Helius pricing is available.
  // Without HELIUS_API_KEY, USD values are unknown, so we sweep every
  // non-zero balance (pricing is a sanity gate, not a blocker — matches
  // the auto-swap-on-close behavior).
  const heliusAvailable = Boolean(process.env.HELIUS_API_KEY);
  let targets;
  if (heliusAvailable) {
    const { getWalletBalances } = await import("../tools/wallet.js");
    const priced = await getWalletBalances().catch(() => ({ tokens: [] }));
    const usdByMint = new Map((priced.tokens || []).map((t) => [t.mint, t.usd]));
    targets = tokens.map((t) => ({ ...t, usd: usdByMint.get(t.mint) ?? null }))
      .filter((t) => t.usd == null || t.usd >= USD_FLOOR);
  } else {
    targets = tokens;
  }

  log("sweep", `Wallet has ${tokens.length} non-SOL token(s), ${targets.length} to sweep${heliusAvailable ? ` (floor=$${USD_FLOOR})` : " (no Helius — sweeping all non-zero)"}`);

  if (targets.length === 0) {
    const summary = { started_at: startedAt, swept: 0, skipped: tokens.length, results: [] };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const results = [];
  for (const token of targets) {
    const r = await sweepToken(token);
    results.push(r);
  }

  const summary = {
    started_at: startedAt,
    dry_run: dryRun,
    floor_usd: heliusAvailable ? USD_FLOOR : null,
    swept: results.filter((r) => r.swapped).length,
    failed: results.filter((r) => !r.swapped && r.error).length,
    results,
  };
  log("sweep", `Sweep done — ${summary.swept} swapped, ${summary.failed} failed`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  log("sweep_error", `Sweep crashed: ${e.message}`);
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
