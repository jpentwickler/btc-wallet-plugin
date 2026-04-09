/**
 * Dev utility: generate a wallet keypair for provisioning.
 *
 * Prints the private key hex (for WALLET_PRIVATE_KEY env var),
 * public key, and boarding address for the target network.
 *
 * Usage: npm run keygen
 *        npm run keygen -- --network mutinynet
 *        npm run keygen -- --network regtest
 */

import { EventSource } from "eventsource";
(globalThis as any).EventSource = EventSource;

import {
  SingleKey,
  Wallet,
  InMemoryWalletRepository,
  InMemoryContractRepository,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

const network = process.argv.includes("--network")
  ? process.argv[process.argv.indexOf("--network") + 1]
  : "mutinynet";

const serverUrls: Record<string, { ark: string; esplora: string }> = {
  mutinynet: {
    ark: "https://mutinynet.arkade.sh",
    esplora: "https://mutinynet.com/api",
  },
  regtest: {
    ark: "http://localhost:7070",
    esplora: "http://localhost:3000",
  },
};

async function main() {
  const urls = serverUrls[network];
  if (!urls) {
    console.error(`Unknown network: ${network}. Use mutinynet or regtest.`);
    process.exit(1);
  }

  // Generate keypair
  const identity = SingleKey.fromRandomBytes();
  const privateKeyHex = identity.toHex();
  const pubkey = await identity.xOnlyPublicKey();

  // Get boarding address
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: urls.ark,
    esploraUrl: urls.esplora,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    settlementConfig: false,
  });
  const boardingAddress = await wallet.getBoardingAddress();

  console.log(`Network:          ${network}`);
  console.log(`Arkade server:    ${urls.ark}`);
  console.log(`Public key:       ${hex.encode(pubkey)}`);
  console.log(`Boarding address: ${boardingAddress}`);
  console.log(``)
  console.log(`──── Set this in Railway secrets ────`);
  console.log(`WALLET_PRIVATE_KEY=${privateKeyHex}`);
  console.log(`────────────────────────────────────`);
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
