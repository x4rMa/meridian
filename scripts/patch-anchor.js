/**
 * Patches @coral-xyz/anchor + @meteora-ag/{dlmm,cp-amm-sdk} for Node 24 ESM.
 *
 * Problem: Node 24 ESM doesn't support bare directory imports (e.g. "utils/bytes").
 * Meteora's index.mjs files do: import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes"
 * ESM never extension-guesses, so it hits the bytes/ directory and throws.
 *
 * Fix 1: Add an exports map to anchor's package.json mapping each util dir to its index.js.
 * Fix 2: Rewrite the bare import in each Meteora SDK's index.mjs to use the explicit path,
 *        and dedupe/alias BN imports (anchor's CJS BN export is unreachable from ESM).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// ─── Fix 1: Patch anchor's package.json exports ──────────────────────────────
const anchorPkgPath = path.join(root, "node_modules/@coral-xyz/anchor/package.json");
const anchorPkg = JSON.parse(fs.readFileSync(anchorPkgPath, "utf8"));
const anchorUtils = path.join(root, "node_modules/@coral-xyz/anchor/dist/cjs/utils");

if (!anchorPkg.exports) {
  const dirs = fs.readdirSync(anchorUtils, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  anchorPkg.exports = {
    // Always serve CJS — anchor's ESM dist has its own bare directory import bugs
    ".": {
      default: "./dist/cjs/index.js",
    },
    // Map each util directory to its explicit CJS index.js
    ...Object.fromEntries(
      dirs.map(dir => [
        `./dist/cjs/utils/${dir}`,
        `./dist/cjs/utils/${dir}/index.js`,
      ])
    ),
    // Allow any other direct file path through
    "./*": "./*",
  };

  fs.writeFileSync(anchorPkgPath, JSON.stringify(anchorPkg, null, 2));
  console.log("Patched: @coral-xyz/anchor/package.json exports");
} else {
  console.log("Skip: @coral-xyz/anchor exports already set");
}

// ─── Fix 2: Patch a Meteora SDK's index.mjs bare directory imports + BN ──────
// Applies to both @meteora-ag/dlmm and @meteora-ag/cp-amm-sdk — they share the
// same anchor-import patterns. Each SDK gets its own pass; a missing SDK (e.g.
// during a partial install) is skipped via fs.existsSync rather than crashing.
function removeBNFromSpecifiers(specifiers) {
  return specifiers
    .split(",")
    .map(s => s.trim())
    .filter(s => s && !/^BN(\s+as\s+\w+)?$/.test(s))
    .join(", ");
}

function patchMeteoraSdk(label, mjsPath) {
  if (!fs.existsSync(mjsPath)) {
    console.log(`Skip: ${label} not present at ${path.relative(root, mjsPath)}`);
    return;
  }
  let src = fs.readFileSync(mjsPath, "utf8");
  const original = src;

  // Replace all bare directory imports of anchor utils with explicit .js paths
  src = src.replace(
    /from ["'](@coral-xyz\/anchor\/dist\/cjs\/utils\/\w+)["']/g,
    (_, p) => `from "${p}/index.js"`
  );

  // ESM cannot find named export 'BN' from CommonJS anchor.
  // Strip any existing duplicate `import BN from "bn.js"` lines first.
  src = src.replace(/^import BN from "bn\.js";\n/gm, "");

  // Add exactly one BN import at the top if BN is used alongside an anchor import.
  if (src.includes('from "@coral-xyz/anchor"') && src.includes('BN')) {
    src = 'import BN from "bn.js";\n' + src;
  }

  // Handle aliased BN imports: import { BN as BN18 } from "@coral-xyz/anchor";
  src = src.replace(
    /import \{([^}]*)\bBN as (\w+)\b([^}]*)\} from "@coral-xyz\/anchor";/g,
    (_, before, alias, after) => {
      const remaining = removeBNFromSpecifiers(before + "," + after);
      const anchorImport = remaining ? `import { ${remaining} } from "@coral-xyz/anchor";` : "";
      return `${anchorImport}\nconst ${alias} = BN;`;
    }
  );

  // Handle named BN imports: import { BN } from "@coral-xyz/anchor";
  src = src.replace(
    /import \{([^}]*)\bBN\b(?!\s*as\b)([^}]*)\} from "@coral-xyz\/anchor";/g,
    (_, before, after) => {
      const remaining = removeBNFromSpecifiers(before + "," + after);
      return remaining ? `import { ${remaining} } from "@coral-xyz/anchor";` : "";
    }
  );

  if (src !== original) {
    fs.writeFileSync(mjsPath, src);
    console.log(`Patched: ${label} directory imports + BN`);
  } else {
    console.log(`Skip: ${label} already patched`);
  }
}

patchMeteoraSdk("@meteora-ag/dlmm", path.join(root, "node_modules/@meteora-ag/dlmm/dist/index.mjs"));
patchMeteoraSdk("@meteora-ag/cp-amm-sdk", path.join(root, "node_modules/@meteora-ag/cp-amm-sdk/dist/index.mjs"));
