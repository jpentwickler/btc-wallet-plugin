/**
 * Dev utility: fund the wallet from the local regtest faucet (Chopsticks).
 *
 * Usage: npm run fund [-- --amount 50000]
 *
 * Requires:
 *   - Local regtest Docker stack running (bash infra/start.sh)
 *   - Wallet key in ~/.btc-wallet/key.enc or WALLET_PRIVATE_KEY env var
 */

import { EventSource } from "eventsource";
(globalThis as any).EventSource = EventSource;

import { SingleKey, Wallet } from "@arkade-os/sdk";
import { loadKey } from "../src/keystore.js";

const FAUCET_URL = process.env.FAUCET_URL ?? "http://localhost:3000/faucet";
const ARK_SERVER = process.env.ARKADE_SERVER ?? "http://localhost:7070";
const ESPLORA_URL = process.env.ESPLORA_URL ?? "http://localhost:3000";

async function main() {
  // 1. Load key
  const envKey = process.env.WALLET_PRIVATE_KEY;
  const stored = loadKey();
  const keyHex = envKey ?? stored?.privateKeyHex;

  if (!keyHex) {
    console.error("No wallet key found. Run create_wallet first or set WALLET_PRIVATE_KEY.");
    process.exit(1);
  }

  const identity = SingleKey.fromHex(keyHex);
  const pubkey = await identity.xOnlyPublicKey();

  // 2. Create wallet to get boarding address
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: ARK_SERVER,
    esploraUrl: ESPLORA_URL,
  });

  const boardingAddr = await wallet.getBoardingAddress();
  console.log(`Wallet:  ${boardingAddr}`);

  // 3. Hit the faucet
  console.log(`Faucet:  ${FAUCET_URL}`);
  const resp = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: boardingAddr }),
  });

  if (!resp.ok) {
    console.error(`Faucet error: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }

  const txid = (await resp.text()).trim();
  console.log(`Funded:  ${txid}`);

  // 4. Wait for balance
  console.log("Waiting for balance...");
  for (let i = 0; i < 30; i++) {
    const balance = await wallet.getBalance();
    const boarding = Number((balance as any).boarding?.total ?? 0);
    const available = Number((balance as any).available ?? 0);
    if (boarding > 0 || available > 0) {
      console.log(`Balance: ${boarding + available} sats (boarding: ${boarding}, available: ${available})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log("Balance not yet visible — check manually with get_balance.");
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
