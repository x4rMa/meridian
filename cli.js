#!/usr/bin/env node
/**
 * meridian — Solana DLMM LP Agent CLI
 * Direct tool invocation with JSON output. Agent-native.
 */

import { loadEnv } from "./envcrypt.js";
import { parseArgs } from "util";
import os from "os";
import fs from "fs";
import path from "path";
import { repoPath, DATA_ROOT } from "./repo-root.js";

// ─── DRY_RUN must be set before any tool imports ─────────────────
if (process.argv.includes("--dry-run")) process.env.DRY_RUN = "true";

// ─── Load .env ───────────────────────────────────────────────────
// Resolution: MERIDIAN_HOME/.env  →  ~/.meridian/.env (legacy)  →  repo .env
if (!process.env.MERIDIAN_HOME && fs.existsSync(path.join(os.homedir(), ".meridian", ".env"))) {
  const meridianDir = path.join(os.homedir(), ".meridian");
  loadEnv({
    envPath: path.join(meridianDir, ".env"),
    keyPath: path.join(meridianDir, ".envrypt"),
    override: false,
  });
}

// ─── Output helpers ───────────────────────────────────────────────
function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function die(msg, extra = {}) {
  process.stderr.write(JSON.stringify({ error: msg, ...extra }) + "\n");
  process.exit(1);
}

// ─── SKILL.md generation ──────────────────────────────────────────
const SKILL_MD = `# meridian — Solana DLMM LP Agent CLI

Data dir: $MERIDIAN_HOME (or repo root if unset)

## Commands

### meridian balance
Returns wallet SOL and token balances.
\`\`\`
Output: { wallet, sol, sol_usd, usdc, tokens: [{mint, symbol, balance, usd_value}], total_usd }
\`\`\`

### meridian positions
Returns all open DLMM positions.
\`\`\`
Output: { positions: [{position, pool, pair, in_range, age_minutes, ...}], total_positions }
\`\`\`

### meridian pnl <position_address>
Returns PnL for a specific position.
\`\`\`
Output: { pnl_pct, pnl_usd, unclaimed_fee_usd, all_time_fees_usd, current_value_usd, lower_bin, upper_bin, active_bin }
\`\`\`

### meridian screen [--dry-run] [--silent]
Runs one AI screening cycle to find and deploy new positions.
\`\`\`
Output: { done: true, report: "..." }
\`\`\`

### meridian manage [--dry-run] [--silent]
Runs one AI management cycle over open positions.
\`\`\`
Output: { done: true, report: "..." }
\`\`\`

### meridian deploy --pool <addr> --amount <sol> [--bins-below 69] [--bins-above 0] [--strategy bid_ask|spot] [--dry-run]
Deploys a new LP position. All safety checks apply.
\`\`\`
Output: { success, position, pool_name, txs, price_range, bin_step }
\`\`\`

### meridian claim --position <addr>
Claims accumulated swap fees for a position.
\`\`\`
Output: { success, position, txs, base_mint }
\`\`\`

### meridian close --position <addr> [--skip-swap] [--dry-run]
Closes a position. Auto-swaps base token to SOL unless --skip-swap.
\`\`\`
Output: { success, pnl_pct, pnl_usd, txs, base_mint }
\`\`\`

### meridian swap --from <mint> --to <mint> --amount <n> [--dry-run]
Swaps tokens via Jupiter. Use "SOL" as mint shorthand.
\`\`\`
Output: { success, tx, input_amount, output_amount }
\`\`\`

### meridian candidates [--limit 5]
Returns top pool candidates fully enriched: pool metrics, token audit, holders, smart wallets, narrative, active bin, pool memory.
\`\`\`
Output: { candidates: [{name, pool, bin_step, fee_pct, volume, tvl, organic_score, active_bin, smart_wallets, token: {holders, audit, global_fees_sol, ...}, holders, narrative, pool_memory}] }
\`\`\`

### meridian study --pool <addr> [--limit 4]
Studies top LPers on a pool. Returns behaviour patterns, hold times, win rates, strategies.
\`\`\`
Output: { pool, patterns: {top_lper_count, avg_hold_hours, avg_win_rate, ...}, lpers: [{owner, summary, positions}] }
\`\`\`

### meridian token-info --query <mint_or_symbol>
Returns token audit, mcap, launchpad, price stats, fee data.
\`\`\`
Output: { results: [{mint, symbol, mcap, launchpad, audit, stats_1h, global_fees_sol, ...}] }
\`\`\`

### meridian token-holders --mint <addr> [--limit 20]
Returns holder distribution, bot %, top holder concentration.
\`\`\`
Output: { mint, holders, top_10_real_holders_pct, bundlers_pct_in_top_100, global_fees_sol, ... }
\`\`\`

### meridian token-narrative --mint <addr>
Returns AI-generated narrative about the token.
\`\`\`
Output: { mint, narrative }
\`\`\`

### meridian pool-detail --pool <addr> [--timeframe 5m]
Returns detailed pool metrics for a specific pool.
\`\`\`
Output: { pool, name, bin_step, fee_pct, volume, tvl, volatility, ... }
\`\`\`

### meridian search-pools --query <name_or_symbol> [--limit 10]
Searches pools by name or token symbol.
\`\`\`
Output: { pools: [{pool, name, bin_step, fee_pct, tvl, volume, ...}] }
\`\`\`

### meridian active-bin --pool <addr>
Returns the current active bin for a pool.
\`\`\`
Output: { pool, binId, price }
\`\`\`

### meridian wallet-positions --wallet <addr>
Returns DLMM positions for any wallet address.
\`\`\`
Output: { wallet, positions: [...], total_positions }
\`\`\`

### meridian config get
Returns the full runtime config.

### meridian config set <key> <value>
Updates a config key. Parses value as JSON when possible.
\`\`\`
Valid keys: minTvl, maxTvl, minVolume, maxPositions, deployAmountSol, managementIntervalMin, screeningIntervalMin, managementModel, screeningModel, generalModel, autoSwapAfterClaim, minClaimAmount, outOfRangeWaitMinutes
\`\`\`

### meridian lessons [--limit 50]
Lists all lessons from lessons.json. Shows rule, tags, pinned status, outcome, role.
\`\`\`
Output: { total, lessons: [{id, rule, tags, outcome, pinned, role, created_at}] }
\`\`\`

### meridian lessons add <text>
Adds a manual lesson with outcome=manual, role=null (applies to all roles).
\`\`\`
Output: { saved: true, rule, outcome, role }
\`\`\`

### meridian pool-memory --pool <addr>
Returns deploy history for a specific pool from pool-memory.json.
\`\`\`
Output: { pool_address, known, name, total_deploys, win_rate, avg_pnl_pct, last_outcome, notes, history }
\`\`\`

### meridian markov <pool_address>
Returns the Markov chain transition matrix and next-state prediction for a pool.
Requires 3+ closed deploys to build a matrix.
\`\`\`
Output: { pool_address, available, pool_name, current_state, predicted_next, confidence, total_transitions, transition_probabilities, entropy }
\`\`\`

### meridian evolve
Runs evolveThresholds() over all closed position data and updates user-config.json.
\`\`\`
Output: { evolved, changes, rationale }
\`\`\`

### meridian blacklist add --mint <addr> --reason <text>
Permanently blacklists a token mint so it is never deployed into.
\`\`\`
Output: { blacklisted, mint, reason }
\`\`\`

### meridian blacklist list
Lists all blacklisted token mints with reasons and timestamps.
\`\`\`
Output: { count, blacklist: [{mint, symbol, reason, added_at}] }
\`\`\`

### meridian performance [--limit 200]
Shows all closed position performance history with summary stats.
\`\`\`
Output: { summary: { total_positions_closed, total_pnl_usd, avg_pnl_pct, win_rate_pct, total_lessons }, count, positions: [...] }
\`\`\`

### meridian analyze-performance --bucket <field> [--bins <edges>] [--metric <m>] [--min-trades <n>]
Generic performance analytics: buckets all closed positions by any persisted field
and prints per-bucket ROI / win-rate / rug-rate stats. Field may be a top-level key
(pnl_pct, entry_mcap, volatility, minutes_held, close_reason) or a signal_snapshot
key (fee_tvl_ratio, organic_score, token_age_hours, age_band, holder_count, volume).
Dotted paths (signal_snapshot.fee_tvl_ratio) are accepted; bare names auto-fall-back
to signal_snapshot.<name> if the top-level key is absent.

--bins accepts comma-separated numeric edges, e.g. \`--bins 0,72,168,720,1440,100000\`.
A trailing \`+\` on the last edge makes it an open upper bucket (e.g. \`1440+\`).
For non-numeric (categorical) fields like close_reason or age_band, omit --bins;
each distinct value becomes its own bucket.

--metric selects the aggregate to display per bucket (default: pnl_pct).
\`\`\`
Output: a table of { bucket, trades, avg_roi, median_roi, win_pct, rug_pct, avg_fees, max_dd } + the raw rows.
\`\`\`
Example: \`meridian analyze-performance --bucket token_age_hours --bins 0,72,168,720,1440+\`

### meridian discord-signals [clear]
Shows pending Discord signal queue from the discord-listener process.
\`\`\`
Output: { count, pending, processed, signals: [{id, symbol, pool, author, channel, queued_at, rug_score, status}] }
\`\`\`

### meridian start [--dry-run]
Starts the autonomous agent with cron jobs (management + screening).

## Flags
--dry-run     Skip all on-chain transactions
--silent      Suppress Telegram notifications for this run
`;

fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.writeFileSync(path.join(DATA_ROOT, "SKILL.md"), SKILL_MD);

// ─── Parse args ───────────────────────────────────────────────────
const argv = process.argv.slice(2);
const subcommand = argv.find(a => !a.startsWith("-"));
const sub2 = argv.filter(a => !a.startsWith("-"))[1]; // for "config get/set"
const silent = argv.includes("--silent");

if (!subcommand || subcommand === "help" || argv.includes("--help")) {
  process.stdout.write(SKILL_MD);
  process.exit(0);
}

// ─── Parse flags ──────────────────────────────────────────────────
const { values: flags } = parseArgs({
  args: argv,
  options: {
    pool:       { type: "string" },
    amount:     { type: "string" },
    position:   { type: "string" },
    from:       { type: "string" },
    to:         { type: "string" },
    strategy:   { type: "string" },
    query:      { type: "string" },
    mint:       { type: "string" },
    wallet:     { type: "string" },
    timeframe:  { type: "string" },
    reason:     { type: "string" },
    "bins-below": { type: "string" },
    "bins-above": { type: "string" },
    "amount-x":   { type: "string" },
    "amount-y":   { type: "string" },
    "bps":        { type: "string" },
    "no-claim":   { type: "boolean" },
    "skip-swap":  { type: "boolean" },
    "dry-run":    { type: "boolean" },
    "silent":     { type: "boolean" },
    limit:        { type: "string" },
    bucket:       { type: "string" },
    bins:         { type: "string" },
    metric:       { type: "string" },
    "min-trades": { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

// ─── Commands ─────────────────────────────────────────────────────

switch (subcommand) {

  // ── balance ──────────────────────────────────────────────────────
  case "balance": {
    const { getWalletBalances } = await import("./tools/wallet.js");
    out(await getWalletBalances({}));
    break;
  }

  // ── positions ────────────────────────────────────────────────────
  case "positions": {
    const { getMyPositions } = await import("./tools/dlmm.js");
    out(await getMyPositions({ force: true }));
    break;
  }

  // ── pnl <position_address> ───────────────────────────────────────
  case "pnl": {
    const posAddr = argv.find((a, i) => !a.startsWith("-") && i > 0 && argv[i - 1] !== "--position" && a !== "pnl");
    const positionAddress = flags.position || posAddr;
    if (!positionAddress) die("Usage: meridian pnl <position_address>");

    const { getTrackedPosition } = await import("./state.js");
    const { getPositionPnl, getMyPositions } = await import("./tools/dlmm.js");

    let poolAddress;
    const tracked = getTrackedPosition(positionAddress);
    if (tracked?.pool) {
      poolAddress = tracked.pool;
    } else {
      // Fall back: scan positions to find pool
      const pos = await getMyPositions({ force: true });
      const found = pos.positions?.find(p => p.position === positionAddress);
      if (!found) die("Position not found", { position: positionAddress });
      poolAddress = found.pool;
    }

    const pnl = await getPositionPnl({ pool_address: poolAddress, position_address: positionAddress });
    if (tracked?.strategy) pnl.strategy = tracked.strategy;
    if (tracked?.instruction) pnl.instruction = tracked.instruction;
    out(pnl);
    break;
  }

  // ── candidates ───────────────────────────────────────────────────
  case "candidates": {
    const { getTopCandidates } = await import("./tools/screening.js");
    const { getActiveBin } = await import("./tools/dlmm.js");
    const { getTokenInfo, getTokenHolders, getTokenNarrative } = await import("./tools/token.js");
    const { checkSmartWalletsOnPool } = await import("./smart-wallets.js");
    const { recallForPool } = await import("./pool-memory.js");

    const limit = parseInt(flags.limit || "5");
    const raw = await getTopCandidates({ limit });
    const pools = raw.candidates || raw.pools || [];

    const enriched = [];
    for (const pool of pools) {
      const mint = pool.base?.mint;
      const [activeBin, smartWallets, tokenInfo, holders, narrative] = await Promise.allSettled([
        getActiveBin({ pool_address: pool.pool }),
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
        mint ? getTokenHolders({ mint }) : Promise.resolve(null),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      ]);
      const ti = tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null;
      enriched.push({
        pool: pool.pool,
        name: pool.name,
        bin_step: pool.bin_step,
        fee_pct: pool.fee_pct,
        fee_active_tvl_ratio: pool.fee_active_tvl_ratio,
        volume: pool.volume_window,
        tvl: pool.tvl ?? pool.active_tvl,
        volatility: pool.volatility,
        mcap: pool.mcap,
        organic_score: pool.organic_score,
        active_pct: pool.active_pct,
        price_change_pct: pool.price_change_pct,
        active_bin: activeBin.status === "fulfilled" ? activeBin.value?.binId : null,
        smart_wallets: smartWallets.status === "fulfilled" ? (smartWallets.value?.in_pool || []).map(w => w.name) : [],
        token: {
          mint,
          symbol: pool.base?.symbol,
          holders: pool.holders,
          mcap: ti?.mcap,
          launchpad: ti?.launchpad,
          global_fees_sol: ti?.global_fees_sol,
          price_change_1h: ti?.stats_1h?.price_change,
          net_buyers_1h: ti?.stats_1h?.net_buyers,
          audit: {
            top10_pct: ti?.audit?.top_holders_pct,
            bots_pct: ti?.audit?.bot_holders_pct,
          },
        },
        holders: holders.status === "fulfilled" ? holders.value : null,
        narrative: narrative.status === "fulfilled" ? narrative.value?.narrative : null,
        pool_memory: recallForPool(pool.pool) || null,
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    out({ candidates: enriched, total_screened: raw.total_screened });
    break;
  }

  // ── token-info ──────────────────────────────────────────────────
  case "token-info": {
    const query = flags.query || flags.mint || argv.find((a, i) => !a.startsWith("-") && i > 0 && a !== "token-info");
    if (!query) die("Usage: meridian token-info --query <mint_or_symbol>");
    const { getTokenInfo } = await import("./tools/token.js");
    out(await getTokenInfo({ query }));
    break;
  }

  // ── token-holders ─────────────────────────────────────────────
  case "token-holders": {
    const mint = flags.mint || argv.find((a, i) => !a.startsWith("-") && i > 0 && a !== "token-holders");
    if (!mint) die("Usage: meridian token-holders --mint <addr>");
    const { getTokenHolders } = await import("./tools/token.js");
    const limit = flags.limit ? parseInt(flags.limit) : 20;
    out(await getTokenHolders({ mint, limit }));
    break;
  }

  // ── token-narrative ───────────────────────────────────────────
  case "token-narrative": {
    const mint = flags.mint || argv.find((a, i) => !a.startsWith("-") && i > 0 && a !== "token-narrative");
    if (!mint) die("Usage: meridian token-narrative --mint <addr>");
    const { getTokenNarrative } = await import("./tools/token.js");
    out(await getTokenNarrative({ mint }));
    break;
  }

  // ── pool-detail ───────────────────────────────────────────────
  case "pool-detail": {
    if (!flags.pool) die("Usage: meridian pool-detail --pool <addr> [--timeframe 5m]");
    const { getPoolDetail } = await import("./tools/screening.js");
    out(await getPoolDetail({ pool_address: flags.pool, timeframe: flags.timeframe || "5m" }));
    break;
  }

  // ── search-pools ──────────────────────────────────────────────
  case "search-pools": {
    const query = flags.query || argv.find((a, i) => !a.startsWith("-") && i > 0 && a !== "search-pools");
    if (!query) die("Usage: meridian search-pools --query <name_or_symbol>");
    const { searchPools } = await import("./tools/dlmm.js");
    const limit = flags.limit ? parseInt(flags.limit) : 10;
    out(await searchPools({ query, limit }));
    break;
  }

  // ── active-bin ────────────────────────────────────────────────
  case "active-bin": {
    if (!flags.pool) die("Usage: meridian active-bin --pool <addr>");
    const { getActiveBin } = await import("./tools/dlmm.js");
    out(await getActiveBin({ pool_address: flags.pool }));
    break;
  }

  // ── wallet-positions ──────────────────────────────────────────
  case "wallet-positions": {
    const wallet = flags.wallet || argv.find((a, i) => !a.startsWith("-") && i > 0 && a !== "wallet-positions");
    if (!wallet) die("Usage: meridian wallet-positions --wallet <addr>");
    const { getWalletPositions } = await import("./tools/dlmm.js");
    out(await getWalletPositions({ wallet_address: wallet }));
    break;
  }

  // ── deploy ───────────────────────────────────────────────────────
  case "deploy": {
    if (!flags.pool) die("Usage: meridian deploy --pool <addr> --amount <sol>");
    const amountX = flags["amount-x"] ? parseFloat(flags["amount-x"]) : undefined;
    if (!flags.amount && !amountX) die("--amount or --amount-x is required");

    const { executeTool } = await import("./tools/executor.js");
    out(await executeTool("deploy_position", {
      pool_address: flags.pool,
      amount_y: flags.amount ? parseFloat(flags.amount) : undefined,
      amount_x: amountX,
      strategy: flags.strategy,
      single_sided_x: argv.includes("--single-sided-x"),
      bins_below: flags["bins-below"] ? parseInt(flags["bins-below"]) : undefined,
      bins_above: flags["bins-above"] ? parseInt(flags["bins-above"]) : undefined,
      allow_duplicate_pool: argv.includes("--allow-duplicate-pool"),
    }));
    break;
  }

  // ── claim ────────────────────────────────────────────────────────
  case "claim": {
    if (!flags.position) die("Usage: meridian claim --position <addr>");
    const { executeTool } = await import("./tools/executor.js");
    out(await executeTool("claim_fees", { position_address: flags.position }));
    break;
  }

  // ── close ────────────────────────────────────────────────────────
  case "close": {
    if (!flags.position) die("Usage: meridian close --position <addr>");
    const { executeTool } = await import("./tools/executor.js");
    out(await executeTool("close_position", {
      position_address: flags.position,
      skip_swap: flags["skip-swap"] ?? false,
    }));
    break;
  }

  // ── swap ─────────────────────────────────────────────────────────
  case "swap": {
    if (!flags.from || !flags.to || !flags.amount) die("Usage: meridian swap --from <mint> --to <mint> --amount <n>");
    const { executeTool } = await import("./tools/executor.js");
    out(await executeTool("swap_token", {
      input_mint: flags.from,
      output_mint: flags.to,
      amount: parseFloat(flags.amount),
    }));
    break;
  }

  // ── screen ───────────────────────────────────────────────────────
  case "screen": {
    const { runScreeningCycle } = await import("./index.js");
    const report = await runScreeningCycle({ silent });
    out({ done: true, report: report || "No action taken" });
    break;
  }

  // ── manage ───────────────────────────────────────────────────────
  case "manage": {
    const { runManagementCycle } = await import("./index.js");
    const report = await runManagementCycle({ silent });
    out({ done: true, report: report || "No action taken" });
    break;
  }

  // ── config ───────────────────────────────────────────────────────
  case "config": {
    if (sub2 === "get" || !sub2) {
      const { config } = await import("./config.js");
      out(config);
    } else if (sub2 === "set") {
      const key = argv.filter(a => !a.startsWith("-"))[2];
      const rawVal = argv.filter(a => !a.startsWith("-"))[3];
      if (!key || rawVal === undefined) die("Usage: meridian config set <key> <value>");
      let value = rawVal;
      try { value = JSON.parse(rawVal); } catch { /* keep as string */ }
      const { executeTool } = await import("./tools/executor.js");
      out(await executeTool("update_config", { changes: { [key]: value }, reason: "CLI config set" }));
    } else {
      die(`Unknown config subcommand: ${sub2}. Use: get, set`);
    }
    break;
  }

  // ── study ────────────────────────────────────────────────────────
  case "study": {
    if (!flags.pool) die("Usage: meridian study --pool <addr> [--limit 4]");
    const { studyTopLPers } = await import("./tools/study.js");
    const limit = flags.limit ? parseInt(flags.limit) : 4;
    out(await studyTopLPers({ pool_address: flags.pool, limit }));
    break;
  }

  // ── start ────────────────────────────────────────────────────────
  case "start": {
    const { startCronJobs } = await import("./index.js");
    process.stderr.write("[meridian] Starting autonomous agent...\n");
    startCronJobs();
    break;
  }

  // ── lessons ──────────────────────────────────────────────────────
  case "lessons": {
    if (sub2 === "add") {
      const text = argv.filter(a => !a.startsWith("-")).slice(2).join(" ");
      if (!text) die("Usage: meridian lessons add <text>");
      const { addLesson } = await import("./lessons.js");
      addLesson(text, [], { pinned: false, role: null });
      out({ saved: true, rule: text, outcome: "manual", role: null });
    } else {
      const { listLessons } = await import("./lessons.js");
      const limit = flags.limit ? parseInt(flags.limit) : 50;
      out(listLessons({ limit }));
    }
    break;
  }

  // ── pool-memory ──────────────────────────────────────────────────
  case "pool-memory": {
    if (!flags.pool) die("Usage: meridian pool-memory --pool <addr>");
    const { getPoolMemory } = await import("./pool-memory.js");
    out(getPoolMemory({ pool_address: flags.pool }));
    break;
  }

  // ── evolve ───────────────────────────────────────────────────────
  case "evolve": {
    const { config } = await import("./config.js");
    const { evolveThresholds } = await import("./lessons.js");
    const fs2 = await import("fs");
    const lessonsFile = "./lessons.json";
    let perfData = [];
    if (fs2.existsSync(lessonsFile)) {
      try { perfData = JSON.parse(fs2.readFileSync(lessonsFile, "utf8")).performance || []; } catch { /* no data */ }
    }
    const result = evolveThresholds(perfData, config);
    if (!result) {
      out({ evolved: false, reason: `Need at least 5 closed positions (have ${perfData.length})` });
    } else {
      out({ evolved: Object.keys(result.changes).length > 0, changes: result.changes, rationale: result.rationale });
    }
    break;
  }

  // ── blacklist ────────────────────────────────────────────────────
  case "blacklist": {
    if (sub2 === "add") {
      if (!flags.mint) die("Usage: meridian blacklist add --mint <addr> --reason <text>");
      if (!flags.reason) die("--reason is required");
      const { addToBlacklist } = await import("./token-blacklist.js");
      out(addToBlacklist({ mint: flags.mint, reason: flags.reason }));
    } else if (sub2 === "list" || !sub2) {
      const { listBlacklist } = await import("./token-blacklist.js");
      out(listBlacklist());
    } else {
      die(`Unknown blacklist subcommand: ${sub2}. Use: add, list`);
    }
    break;
  }

  // ── performance ──────────────────────────────────────────────────
  case "performance": {
    const { getPerformanceHistory, getPerformanceSummary } = await import("./lessons.js");
    const limit = flags.limit ? parseInt(flags.limit) : 200;
    const history = getPerformanceHistory({ hours: 999999, limit });
    const summary = getPerformanceSummary();
    out({ summary, ...history });
    break;
  }

  // ── analyze-performance ─────────────────────────────────────────
  // Generic performance analytics: bucket historical trades by any persisted
  // field and print per-bucket ROI / win-rate / rug-rate stats. Built to
  // validate/refute the "rug danger zone" hypothesis with real data, but
  // field-agnostic — works for entry_mcap, fee_tvl_ratio, holder_count, etc.
  case "analyze-performance": {
    const bucket = flags.bucket;
    if (!bucket) die("Usage: meridian analyze-performance --bucket <field> [--bins <edges>] [--metric pnl_pct] [--min-trades 3]\n  Example: meridian analyze-performance --bucket token_age_hours --bins 0,72,168,720,1440+");
    const { getAllPerformance } = await import("./lessons.js");
    const rows = getAllPerformance();
    if (!rows.length) { out({ message: "No closed positions recorded yet.", buckets: [] }); break; }

    const metric = flags.metric || "pnl_pct";
    const minTrades = flags["min-trades"] ? parseInt(flags["min-trades"]) : 1;

    // Resolve a (possibly dotted) field from a row. Bare names fall back to
    // signal_snapshot.<name> if the top-level key is absent — so "fee_tvl_ratio"
    // works without the caller knowing it lives in signal_snapshot.
    function resolveField(row, field) {
      if (field.includes(".")) {
        return field.split(".").reduce((o, k) => (o == null ? o : o[k]), row);
      }
      if (row[field] !== undefined) return row[field];
      return row?.signal_snapshot?.[field];
    }

    const rawValues = rows.map((r) => resolveField(r, bucket));
    const allNumeric = rawValues.every((v) => v == null || typeof v === "number" || typeof v === "bigint");

    // Build bucket key per row.
    let binEdges = null;
    let openUpper = false;
    if (flags.bins) {
      const parts = flags.bins.split(",").map((s) => s.trim()).filter(Boolean);
      // trailing "+" → open upper bucket
      const last = parts[parts.length - 1];
      if (last.endsWith("+")) { openUpper = true; parts[parts.length - 1] = last.slice(0, -1); }
      binEdges = parts.map((s) => Number(s)).filter((n) => Number.isFinite(n));
      if (binEdges.length < 1) die(`--bins "${flags.bins}" parsed to no numeric edges`);
      binEdges.sort((a, b) => a - b);
    }

    function bucketLabelFor(value) {
      if (value == null) return "unknown";
      if (binEdges == null) {
        // categorical
        return String(value);
      }
      const n = Number(value);
      if (!Number.isFinite(n)) return "non-numeric";
      for (let i = 0; i < binEdges.length; i++) {
        const lo = binEdges[i];
        const hi = (i + 1 < binEdges.length) ? binEdges[i + 1] : (openUpper ? Infinity : null);
        if (hi == null) {
          // single edge, no open-upper: bucket is ">= edge"
          if (n >= lo) return `>=${lo}`;
        } else if (n >= lo && n < hi) {
          return `${lo}-${hi}`;
        }
      }
      // Above the last finite edge with openUpper off → ">= last"
      if (!openUpper && n >= binEdges[binEdges.length - 1]) return `>=${binEdges[binEdges.length - 1]}`;
      return `>=${binEdges[binEdges.length - 1]}`;
    }

    // Group rows by bucket.
    const groups = new Map();
    for (const r of rows) {
      const v = resolveField(r, bucket);
      const label = bucketLabelFor(v);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(r);
    }

    // Order buckets: numeric bins in ascending edge order, then "unknown"/"non-numeric" last.
    function bucketOrder(a, b) {
      const rank = (lbl) => {
        if (lbl === "unknown") return 1e9;
        if (lbl === "non-numeric") return 1e9 + 1;
        const m = lbl.match(/^(\d+(?:\.\d+)?)/);
        return m ? Number(m[1]) : 1e8;
      };
      return rank(a) - rank(b);
    }

    const RUG_REASONS = new Set(["stop loss", "stoploss", "emergency", "rug", "abandoned", "dump"]);
    function isRug(closeReason) {
      const c = String(closeReason || "").toLowerCase();
      return RUG_REASONS.has(c) || c.includes("stop loss") || c.includes("rug");
    }

    const buckets = [...groups.entries()].sort((a, b) => bucketOrder(a[0], b[0])).map(([label, groupRows]) => {
      const trades = groupRows.length;
      const metrics = groupRows.map((r) => Number(resolveField(r, metric))).filter((n) => Number.isFinite(n));
      const pnls = groupRows.map((r) => Number(r.pnl_pct)).filter((n) => Number.isFinite(n));
      const fees = groupRows.map((r) => Number(r.fees_earned_usd)).filter((n) => Number.isFinite(n));
      const maxDDs = groupRows.map((r) => {
        // max drawdown proxy: worst pnl_pct observed (most negative). If a real
        // max_drawdown field is ever recorded, prefer it.
        const p = Number(r.pnl_pct);
        return Number.isFinite(p) ? Math.min(0, p) : null;
      }).filter((n) => n != null);
      const sorted = [...metrics].sort((a, b) => a - b);
      const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
      const wins = pnls.filter((p) => p > 0).length;
      const rugs = groupRows.filter((r) => isRug(r.close_reason)).length;
      const avg = (arr) => arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : null;
      return {
        bucket: label,
        trades,
        avg_roi: avg(metrics) != null ? Math.round(avg(metrics) * 100) / 100 : null,
        median_roi: median != null ? Math.round(median * 100) / 100 : null,
        win_pct: pnls.length ? Math.round((wins / pnls.length) * 100) : null,
        rug_pct: trades ? Math.round((rugs / trades) * 100) : null,
        avg_fees_usd: avg(fees) != null ? Math.round(avg(fees) * 1000) / 1000 : null,
        max_dd_pct: maxDDs.length ? Math.round(Math.min(...maxDDs) * 100) / 100 : null,
      };
    });

    // Filter buckets below min-trades (kept but flagged if trades < min).
    const report = {
      bucket_field: bucket,
      metric,
      bins: binEdges,
      open_upper: openUpper,
      categorical: !allNumeric || binEdges == null,
      total_trades: rows.length,
      buckets: buckets.filter((b) => b.trades >= minTrades),
      buckets_below_min: buckets.filter((b) => b.trades < minTrades).map((b) => ({ bucket: b.bucket, trades: b.trades })),
    };

    // Pretty-print the table to stderr for quick reading; full JSON to stdout (out()).
    const header = ["bucket", "trades", "avg_roi", "median_roi", "win_pct", "rug_pct", "avg_fees", "max_dd"];
    const fmt = (v, w) => String(v == null ? "-" : v).padEnd(w).slice(0, w);
    console.error(`\nanalyze-performance — bucket=${bucket} metric=${metric} (n=${rows.length})`);
    console.error(header.map((h, i) => fmt(h, [16, 7, 9, 11, 8, 8, 11, 9][i])).join("  "));
    console.error("-".repeat(88));
    for (const b of report.buckets) {
      console.error([
        fmt(b.bucket, 16), fmt(b.trades, 7), fmt(b.avg_roi, 9), fmt(b.median_roi, 11),
        fmt(b.win_pct != null ? b.win_pct + "%" : "-", 8), fmt(b.rug_pct != null ? b.rug_pct + "%" : "-", 8),
        fmt(b.avg_fees_usd, 11), fmt(b.max_dd_pct, 9),
      ].join("  "));
    }
    if (report.buckets_below_min.length) {
      console.error(`\nbuckets below min-trades (${minTrades}): ${report.buckets_below_min.map((b) => `${b.bucket}(${b.trades})`).join(", ")}`);
    }
    out(report);
    break;
  }

  // ── discord-signals ──────────────────────────────────────────────
  case "discord-signals": {
    const sigFile = repoPath("discord-signals.json");
    if (!fs.existsSync(sigFile)) {
      out({ count: 0, pending: 0, signals: [], message: "No discord-signals.json found. Is the listener running?" });
      break;
    }
    let signals = [];
    try { signals = JSON.parse(fs.readFileSync(sigFile, "utf8")); } catch { die("Failed to parse discord-signals.json"); }

    if (sub2 === "clear") {
      // Remove processed/old signals (keep pending ones)
      const pending = signals.filter(s => s.status === "pending");
      fs.writeFileSync(sigFile, JSON.stringify(pending, null, 2));
      out({ cleared: signals.length - pending.length, remaining: pending.length });
      break;
    }

    const pending = signals.filter(s => s.status === "pending");
    const processed = signals.filter(s => s.status !== "pending");
    out({
      count: signals.length,
      pending: pending.length,
      processed: processed.length,
      signals: signals.map(s => ({
        id: s.id,
        symbol: s.base_symbol,
        pool: s.pool_address,
        author: s.discord_author,
        channel: s.discord_channel,
        queued_at: s.queued_at,
        rug_score: s.rug_score,
        status: s.status,
        snippet: s.discord_message_snippet?.slice(0, 60),
      })),
    });
    break;
  }

  // ── withdraw-liquidity ─────────────────────────────────────────
  case "withdraw-liquidity": {
    if (!flags.position) die("Usage: meridian withdraw-liquidity --position <addr> --pool <addr> [--bps 10000]");
    if (!flags.pool) die("--pool is required");
    const { withdrawLiquidity } = await import("./tools/dlmm.js");
    out(await withdrawLiquidity({
      position_address: flags.position,
      pool_address: flags.pool,
      bps: flags.bps ? parseInt(flags.bps) : 10000,
      claim_fees: !argv.includes("--no-claim"),
    }));
    break;
  }

  // ── add-liquidity ──────────────────────────────────────────────
  case "add-liquidity": {
    if (!flags.position) die("Usage: meridian add-liquidity --position <addr> --pool <addr> [--amount-x <n>] [--amount-y <n>]");
    if (!flags.pool) die("--pool is required");
    const { addLiquidity } = await import("./tools/dlmm.js");
    out(await addLiquidity({
      position_address: flags.position,
      pool_address: flags.pool,
      amount_x: flags["amount-x"] ? parseFloat(flags["amount-x"]) : 0,
      amount_y: flags["amount-y"] ? parseFloat(flags["amount-y"]) : 0,
      strategy: flags.strategy || "spot",
      single_sided_x: argv.includes("--single-sided-x"),
    }));
    break;
  }

  // ── markov <pool_address> ───────────────────────────────────────
  case "markov": {
    const poolAddr = flags.pool || argv.find((a, i) => !a.startsWith("-") && i > 0 && a !== "markov");
    if (!poolAddr) die("Usage: meridian markov <pool_address>");
    const { getMarkovState } = await import("./markov.js");
    out(await getMarkovState({ pool_address: poolAddr }));
    break;
  }

  default:
    die(`Unknown command: ${subcommand}. Run 'meridian help' for usage.`);
}
