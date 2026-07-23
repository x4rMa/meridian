const path = require("path");
const os = require("os");

const repoRoot = __dirname;

module.exports = {
  apps: [
    {
      name: "meridian",
      script: path.join(repoRoot, "index.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      merge_logs: true,
      time: true,
      // Always start via this file (npm run pm2:start) so cwd + script path stay pinned to the repo.
      env: {
        NODE_ENV: "production",
      },
    },
    // ─────────────────────────────────────────────────────────────────────────
    // HIBERNATED 2026-07-23 — meridian-degen parked for an indefinite period.
    // It was crash-looping on boot (invalid entryPreset `fibo_gann_rsi_divergence_mtf`
    // + unsupported `1_HOUR` interval in ~/.meridian-wallets/degen/user-config.json)
    // and all 17 prior positions were already closed, so no live capital is at risk.
    //
    // To revive: fix the degen user-config.json (entryPreset/exitPreset must be a
    // supported preset; intervals must be a subset of {5_MINUTE, 15_MINUTE}), then
    // uncomment this block and run `pm2 start ecosystem.config.cjs --only meridian-degen`.
    // Data dir + state are untouched at ~/.meridian-wallets/degen/.
    // ─────────────────────────────────────────────────────────────────────────
    // {
    //   name: "meridian-degen",
    //   script: path.join(repoRoot, "index.js"),
    //   cwd: repoRoot,
    //   interpreter: "node",
    //   instances: 1,
    //   exec_mode: "fork",
    //   autorestart: true,
    //   restart_delay: 7000,
    //   kill_timeout: 10000,
    //   max_restarts: 10,
    //   min_uptime: "10s",
    //   merge_logs: true,
    //   time: true,
    //   env: {
    //     NODE_ENV: "production",
    //     MERIDIAN_HOME: path.join(os.homedir(), ".meridian-wallets", "degen"),
    //   },
    // },
  ],
};