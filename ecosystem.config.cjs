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
    {
      // Degen wallet — isolated data dir via MERIDIAN_HOME. Shares the codebase
      // with `meridian` but has its own state.json, user-config.json, lessons,
      // pool-memory, .env, and Telegram bot. Staggered cadence (mgmt 5m /
      // screen 15m) vs primary to reduce Meteora/DexScreener 429 collisions.
      name: "meridian-degen",
      script: path.join(repoRoot, "index.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 7000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: "production",
        MERIDIAN_HOME: path.join(os.homedir(), ".meridian-wallets", "degen"),
      },
    },
  ],
};