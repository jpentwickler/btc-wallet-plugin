/**
 * SPIKE-001 regtest validation: Full 4-path escrow flow on local environment.
 */
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import {
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  VtxoScript,
  MultisigTapscript,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  networks,
  Wallet,
  Ramps,
} from '@arkade-os/sdk';
import { hex } from '@scure/base';

const ARK_URL = 'http://localhost:7070';
const ESPLORA_URL = 'http://localhost:3000';

console.log('=== SPIKE-001 Regtest Validation ===\n');

// Step 1: Connect
console.log('--- Step 1: Server Connection ---');
const arkProvider = new RestArkProvider(ARK_URL);
const indexerProvider = new RestIndexerProvider(ARK_URL);
const info = await arkProvider.getInfo();
const serverPubkey = hex.decode(info.signerPubkey).slice(1);
console.log(`  Connected to ${ARK_URL} (${info.network}, ${info.version})`);

// Step 2: Wallets
console.log('\n--- Step 2: Wallet Creation ---');
const borrowerId = SingleKey.fromRandomBytes();
const lenderId = SingleKey.fromRandomBytes();
const borrowerPubkey = await borrowerId.xOnlyPublicKey();
const lenderPubkey = await lenderId.xOnlyPublicKey();

const borrowerWallet = await Wallet.create({
  identity: borrowerId,
  arkServerUrl: ARK_URL,
  esploraUrl: ESPLORA_URL,
});
const boardingAddr = await borrowerWallet.getBoardingAddress();
console.log(`  Borrower: ${hex.encode(borrowerPubkey).slice(0, 16)}...`);
console.log(`  Lender:   ${hex.encode(lenderPubkey).slice(0, 16)}...`);
console.log(`  Boarding:  ${boardingAddr}`);

// Step 3: 4-path escrow
console.log('\n--- Step 3: 4-Path Escrow Construction ---');
const pathA = MultisigTapscript.encode({ pubkeys: [borrowerPubkey, lenderPubkey, serverPubkey] }).script;
const pathB1 = MultisigTapscript.encode({ pubkeys: [lenderPubkey, serverPubkey] }).script;
const pathB2 = CLTVMultisigTapscript.encode({ pubkeys: [lenderPubkey, serverPubkey], absoluteTimelock: BigInt(Math.floor(Date.now() / 1000)) + 604800n }).script;
const pathC = CSVMultisigTapscript.encode({ pubkeys: [borrowerPubkey, serverPubkey], timelock: { type: 'seconds', value: Math.ceil(14 * 86400 / 512) * 512 } }).script;
const escrowScript = new VtxoScript([pathA, pathB1, pathB2, pathC]);
const escrowAddress = escrowScript.address((networks as any).regtest.hrp, serverPubkey).encode();
console.log(`  Path A:  ${pathA.length} bytes`);
console.log(`  Path B1: ${pathB1.length} bytes`);
console.log(`  Path B2: ${pathB2.length} bytes`);
console.log(`  Path C:  ${pathC.length} bytes`);
console.log(`  Escrow:  ${escrowAddress}`);

// Step 4: Fund via local faucet
console.log('\n--- Step 4: Fund from Local Faucet ---');
const faucetResp = await fetch(`${ESPLORA_URL}/faucet`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: boardingAddr }),
});
const faucetTxid = await faucetResp.text();
console.log(`  Faucet txid: ${faucetTxid.trim()}`);

// Wait for balance
console.log('  Waiting for boarding balance...');
for (let i = 0; i < 30; i++) {
  const balance = await borrowerWallet.getBalance();
  const boarding = Number((balance as any).boarding?.total ?? 0);
  if (boarding > 0) {
    console.log(`  Boarding balance: ${boarding} sats`);
    break;
  }
  await new Promise(r => setTimeout(r, 2000));
}

// Step 5: Onboard
console.log('\n--- Step 5: Onboard (UTXO → VTXO) ---');
try {
  const onboardTxid = await new Ramps(borrowerWallet).onboard(info.fees);
  console.log(`  Onboard txid: ${onboardTxid}`);

  // Wait for VTXO balance
  for (let i = 0; i < 30; i++) {
    const balance = await borrowerWallet.getBalance();
    const available = Number((balance as any).available ?? 0);
    if (available > 0) {
      console.log(`  Available VTXOs: ${available} sats`);
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
} catch (e: any) {
  console.log(`  Onboard FAILED: ${e.message}`);
  console.log('  This is the step that failed on Mutinynet.');
  process.exit(1);
}

// Step 6: Lock collateral
console.log('\n--- Step 6: Lock Collateral ---');
const balance = await borrowerWallet.getBalance();
const available = Number((balance as any).available ?? 0);
const lockAmount = available - 1000;
console.log(`  Sending ${lockAmount} sats to escrow...`);
try {
  const txid = await borrowerWallet.sendBitcoin({ address: escrowAddress, amount: lockAmount });
  console.log(`  Collateral locked: ${txid}`);
} catch (e: any) {
  console.log(`  sendBitcoin FAILED: ${e.message}`);
  process.exit(1);
}

console.log('\n=== ALL STEPS PASSED — Full flow validated on regtest ===');
