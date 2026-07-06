import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the Meridian repo root — stable under PM2, npm start, and CLI. */
export const REPO_ROOT = __dirname;

/**
 * Data root: where state files, .env, and logs live.
 * Resolution order:
 *   1. MERIDIAN_HOME env var (explicit per-wallet isolation)
 *   2. ~/.meridian/ (legacy single-wallet home)
 *   3. REPO_ROOT (bare-repo fallback)
 */
function resolveDataRoot() {
  if (process.env.MERIDIAN_HOME) {
    const p = path.resolve(process.env.MERIDIAN_HOME);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    return p;
  }
  // No MERIDIAN_HOME: default to repo root so bare-repo runs (tests, dev) keep working.
  // cli.js still handles the legacy ~/.meridian/.env lookup separately for env loading.
  return REPO_ROOT;
}
export const DATA_ROOT = resolveDataRoot();

/** State/config/log files resolve against DATA_ROOT; everything else against REPO_ROOT. */
const STATE_FILES = new Set([
  "user-config.json",
  "state.json",
  "lessons.json",
  "pool-memory.json",
  "decision-log.json",
  "signal-weights.json",
  "strategy-library.json",
  "smart-wallets.json",
  "token-blacklist.json",
  "dev-blocklist.json",
  "deployer-blacklist.json",
  "discord-signals.json",
  "hivemind-cache.json",
  "gmgn-config.json",
  ".env",
  ".envrypt",
]);

export function repoPath(...segments) {
  const top = segments[0];
  if (STATE_FILES.has(top) || top === "logs") {
    return path.join(DATA_ROOT, ...segments);
  }
  return path.join(REPO_ROOT, ...segments);
}
