// stoker.mjs — CLAWD Incinerator keeper bot
//
// Strategy: the rival lands 2s after every cooldown expiry, which on Base's
// 2-second blocks means they're in the FIRST eligible block. To beat them we
// must be in that same block, ordered ahead. OP-stack sequencers order by
// priority fee, so we (1) pre-sign the tx before the window opens, (2) fire
// slightly BEFORE the window using chain-time (not wall-clock), and (3) pay a
// higher priority fee than they do. If we fire too early and revert, we lose
// fractions of a cent and instantly re-fire.
//
// Env vars (all but PRIVATE_KEY optional):
//   PRIVATE_KEY        - hex private key of a DEDICATED wallet holding a little Base ETH
//   RPC_URL            - low-latency HTTP RPC (paid Alchemy/QuickNode strongly recommended)
//   PRIORITY_GWEI      - priority fee in gwei (default 0.2 — rival pays ~0.105 total)
//   LEAD_MS            - ms before the eligible block's seal time to broadcast (default 900:
//                        inside the 2s gap after the previous block, so no revert, but
//                        comfortably in the pool before the eligible block is built)
//   GAS_LIMIT          - fixed gas limit (default 200000; observed usage ~107k)

import {
  createPublicClient, http, parseGwei, formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// ---------- config ----------
const CONTRACT = "0x536453350F2EeE2EB8bFeE1866bAF4fCa494A092";
const INCINERATE_DATA = "0xbbd1d251"; // incinerate()
const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const PRIORITY_GWEI = process.env.PRIORITY_GWEI || "0.2";
const LEAD_MS = Number(process.env.LEAD_MS || 900);
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT || 200000);

const ABI = [
  { name: "lastIncinerateTime", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "cooldownSeconds",    type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "clawdBalance",       type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "burnAmount",         type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

// ---------- setup ----------
if (!process.env.PRIVATE_KEY) {
  console.error("FATAL: set PRIVATE_KEY env var (use a fresh dedicated wallet, never your main one)");
  process.exit(1);
}
const account = privateKeyToAccount(
  process.env.PRIVATE_KEY.startsWith("0x") ? process.env.PRIVATE_KEY : "0x" + process.env.PRIVATE_KEY
);
const pub = createPublicClient({ chain: base, transport: http(RPC_URL) });

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- chain-time sync ----------
// Block timestamps are whole seconds, so a single read gives ±1s slop. Instead:
// poll for the moment the block number increments — at that instant, chain time
// ≈ the new block's timestamp almost exactly. Gives offset accuracy of ~±150ms.
async function calibrateChainClock() {
  const first = await pub.getBlock({ blockTag: "latest" });
  const deadline = Date.now() + 7000; // ~3 block intervals max
  let prevNum = first.number;
  while (Date.now() < deadline) {
    await sleep(120);
    const blk = await pub.getBlock({ blockTag: "latest" });
    if (blk.number > prevNum) {
      return { offsetMs: Number(blk.timestamp) * 1000 - Date.now(), gridTs: Number(blk.timestamp) };
    }
  }
  // fallback: coarse offset from latest block (conservative: fires later, not earlier)
  return { offsetMs: Number(first.timestamp) * 1000 - Date.now(), gridTs: Number(first.timestamp) };
}

// Base seals a block every 2s on a fixed grid. The contract's check passes in the
// first block whose timestamp >= (last + cooldown) — THAT block is the finish line.
// Compute its timestamp from the grid, then broadcast LEAD_MS before it's sealed:
// late enough to miss the previous (reverting) block, early enough to be in the
// sequencer's pool when the eligible one is built.
function eligibleBlockTs(nextAt, gridTs) {
  const BLOCK_SECS = 2;
  const delta = nextAt - gridTs;
  const steps = Math.max(0, Math.ceil(delta / BLOCK_SECS));
  return gridTs + steps * BLOCK_SECS;
}

// ---------- reads ----------
async function readState() {
  const [last, cd, bal, burnAmt] = await Promise.all([
    pub.readContract({ address: CONTRACT, abi: ABI, functionName: "lastIncinerateTime" }),
    pub.readContract({ address: CONTRACT, abi: ABI, functionName: "cooldownSeconds" }),
    pub.readContract({ address: CONTRACT, abi: ABI, functionName: "clawdBalance" }),
    pub.readContract({ address: CONTRACT, abi: ABI, functionName: "burnAmount" }),
  ]);
  return { last: Number(last), cd: Number(cd), bal, burnAmt };
}

// ---------- tx prep + fire ----------
async function presign(nonce) {
  const priority = parseGwei(PRIORITY_GWEI);
  const block = await pub.getBlock({ blockTag: "latest" });
  const baseFee = block.baseFeePerGas ?? parseGwei("0.005");
  // account.signTransaction is fully offline — zero network calls at fire time
  const serialized = await account.signTransaction({
    to: CONTRACT,
    data: INCINERATE_DATA,
    gas: GAS_LIMIT,
    maxPriorityFeePerGas: priority,
    maxFeePerGas: baseFee * 3n + priority, // generous headroom; unused fee is refunded
    nonce,
    chainId: base.id,
    type: "eip1559",
  });
  return serialized;
}

async function fire(serialized) {
  const t0 = Date.now();
  const hash = await pub.sendRawTransaction({ serializedTransaction: serialized });
  log(`fired ${hash} (broadcast took ${Date.now() - t0}ms)`);
  return hash;
}

// ---------- main loop ----------
async function cycle() {
  const { last, cd, bal, burnAmt } = await readState();

  if (bal < burnAmt) {
    log(`furnace out of fuel (${formatEther(bal)} CLAWD < burn size) — checking again in 30min`);
    await sleep(30 * 60 * 1000);
    return;
  }

  const nextAt = last + cd; // chain-time seconds when the cooldown check passes

  // Coarse wait first (cheap single block read), precise calibration only near the window
  const roughOffset = Number((await pub.getBlock({ blockTag: "latest" })).timestamp) * 1000 - Date.now();
  const roughWaitMs = nextAt * 1000 - (Date.now() + roughOffset);
  log(`window opens in ${(roughWaitMs / 1000 / 60).toFixed(1)}min`);

  if (roughWaitMs > 30000) {
    await sleep(roughWaitMs - 20000);
    return; // loop re-reads state fresh — catches param changes or surprise burns
  }

  // ---- inside the 30s prep zone ----
  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  let serialized = await presign(nonce);

  // Calibrate against a live block seal, then target the first eligible block
  const { offsetMs, gridTs } = await calibrateChainClock();
  const targetTs = eligibleBlockTs(nextAt, gridTs);
  const fireAtLocalMs = targetTs * 1000 - offsetMs - LEAD_MS;
  log(`pre-signed nonce ${nonce}, priority ${PRIORITY_GWEI} gwei · eligible block ts ${targetTs} (grid-aligned) · offset ${offsetMs}ms · firing ${LEAD_MS}ms before seal`);

  // busy-wait the last stretch with 25ms precision
  while (Date.now() < fireAtLocalMs) {
    await sleep(Math.min(25, fireAtLocalMs - Date.now()));
  }

  await fire(serialized);

  // ---- resolve the race ----
  // Re-fire instantly on "too early" reverts until either we win or state shows a rival won.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(1200);
    const fresh = await readState();
    if (fresh.last > last) {
      // A burn landed. Was it ours?
      // Cheap check: our nonce advanced AND lastIncinerateTime moved in the same beat.
      const newNonce = await pub.getTransactionCount({ address: account.address, blockTag: "latest" });
      if (newNonce > nonce) {
        log(`🔥 WON the window — burn recorded at ${new Date(fresh.last * 1000).toISOString()}`);
      } else {
        log(`lost the window — rival landed at ${new Date(fresh.last * 1000).toISOString()}. Next round.`);
      }
      return;
    }
    // Window is open but no burn recorded → our early shot likely reverted. Re-fire.
    const newNonce = await pub.getTransactionCount({ address: account.address, blockTag: "latest" });
    if (newNonce > nonce) {
      nonce = newNonce;
      serialized = await presign(nonce);
    }
    log("no burn recorded yet — re-firing");
    await fire(serialized);
  }
  log("race window closed without resolution — looping");
}

async function main() {
  log(`stoker online — wallet ${account.address}`);
  const ethBal = await pub.getBalance({ address: account.address });
  log(`gas balance: ${formatEther(ethBal)} ETH on Base`);
  if (ethBal === 0n) log("WARNING: zero ETH — fund this wallet with ~0.002 ETH on Base or nothing will fire");

  // never die: one bad RPC response shouldn't kill months of uptime
  for (;;) {
    try { await cycle(); }
    catch (e) {
      log("cycle error:", e.shortMessage || e.message || e);
      await sleep(5000);
    }
  }
}

main();
