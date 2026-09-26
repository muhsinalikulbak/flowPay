#!/usr/bin/env node
/**
 * Assembles deployment.json for the frontend team.
 *
 *   node script/gen-deployment-json.mjs
 *
 * Reads the compiled ABI from the forge artifact and the deployed address from
 * forge's own broadcast record, so the file can never drift from what was
 * actually deployed or from the compiled contract.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHAIN_ID = 10143;
const NETWORK = "monad_testnet";
const RPC_URL = "https://testnet-rpc.monad.xyz";
const EXPLORER = "https://testnet.monadscan.com";
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

const ARTIFACT = resolve(ROOT, "out/TimeStream.sol/TimeStream.json");
const BROADCAST = resolve(ROOT, `broadcast/DeployTimeStream.s.sol/${CHAIN_ID}/run-latest.json`);
const OUT = resolve(ROOT, "deployment.json");

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

if (!existsSync(ARTIFACT)) fail(`artifact not found, run 'forge build' first: ${ARTIFACT}`);
if (!existsSync(BROADCAST)) {
  fail(`broadcast record not found, run the deploy script with --broadcast first: ${BROADCAST}`);
}

const { abi } = JSON.parse(readFileSync(ARTIFACT, "utf8"));
const broadcast = JSON.parse(readFileSync(BROADCAST, "utf8"));

const createTx = (broadcast.transactions ?? []).find(
  (t) => t.contractName === "TimeStream" && t.transactionType === "CREATE",
);
if (!createTx?.contractAddress) fail(`no TimeStream CREATE transaction found in ${BROADCAST}`);

const deployment = {
  contractName: "TimeStream",
  address: createTx.contractAddress,
  chainId: CHAIN_ID,
  network: NETWORK,
  rpcUrl: RPC_URL,
  explorerUrl: `${EXPLORER}/address/${createTx.contractAddress}`,
  deployTxHash: createTx.hash ?? null,
  deployedAt: new Date().toISOString(),
  // Handy for the frontend: the ERC-20 streams are denominated in.
  usdc: { address: USDC, symbol: "USDC", decimals: 6 },
  abi,
};

writeFileSync(OUT, `${JSON.stringify(deployment, null, 2)}\n`);

console.log(`wrote ${OUT}`);
console.log(`  address : ${deployment.address}`);
console.log(`  chainId : ${deployment.chainId}`);
console.log(`  rpcUrl  : ${deployment.rpcUrl}`);
console.log(`  abi     : ${abi.length} entries`);
