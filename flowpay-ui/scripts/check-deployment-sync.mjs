#!/usr/bin/env node
/**
 * Fails the build if flowpay-ui/deployment.json has drifted from the canonical
 * back/deployment.json.
 *
 *   node scripts/check-deployment-sync.mjs
 *
 * The frontend imports `./deployment.json` rather than reaching into the
 * sibling Foundry project, because the Vercel project is rooted at
 * flowpay-ui and never sees ../back/. A copy is therefore unavoidable - the
 * only question is whether it can silently go stale, and this is what stops
 * that. Both files are written in one go by
 * back/script/gen-deployment-json.mjs, so if this ever fires the fix is to
 * re-run that script, not to edit either file by hand.
 *
 * Exits 0 without checking anything when the canonical file is absent, which
 * is the normal case on Vercel, where only this directory is uploaded.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL = resolve(ROOT, "..", "back", "deployment.json");
const COPY = resolve(ROOT, "deployment.json");

if (!existsSync(CANONICAL)) {
  console.log("check-deployment-sync: back/deployment.json not reachable, skipping (expected on Vercel)");
  process.exit(0);
}

if (!existsSync(COPY)) {
  console.error(
    `error: ${relative(process.cwd(), COPY)} is missing.\n` +
      `       Regenerate it with: cd ../back && node script/gen-deployment-json.mjs`,
  );
  process.exit(1);
}

const canonicalText = readFileSync(CANONICAL, "utf8");
const copyText = readFileSync(COPY, "utf8");

if (canonicalText === copyText) {
  console.log("check-deployment-sync: deployment.json is in sync with back/deployment.json");
  process.exit(0);
}

let summary;
try {
  const { address, deployedAt, abi } = JSON.parse(copyText);
  summary = `\n       the checked-in copy targets address ${address} (deployedAt ${deployedAt}, abi ${abi.length} entries)`;
} catch {
  summary = "\n       the checked-in copy is not even valid JSON";
}

console.error(
  `error: ${relative(process.cwd(), COPY)} has drifted from back/deployment.json.${summary}\n` +
    `       The frontend would talk to a contract it can no longer describe.\n` +
    `       Regenerate both with: cd ../back && node script/gen-deployment-json.mjs`,
);
process.exit(1);
