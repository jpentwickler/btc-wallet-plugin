/**
 * SPIKE-003: Escrow Round-Trip on Mutinynet — Lock, Release, Verify Return
 *
 * Validates the full Path A escrow lifecycle on Mutinynet (live testnet):
 *   Steps 1-3: Connect, create wallets, build escrow
 *   Steps 4-5: Fund check + onboard, lock collateral
 *   Step 6:    Path A collaborative release (borrower + lender + server)
 *   Step 7:    Verify BTC returned to borrower, escrow drained
 *
 * Run: cd reference && npx tsx spike003-mutinynet-round-trip.ts
 * Or:  cd reference && BORROWER_PRIVATE_KEY=<hex> npx tsx spike003-mutinynet-round-trip.ts
 *
 * Prereq: Borrower wallet funded on Mutinynet (via faucet or prior use)
 */
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import {
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  VtxoScript,
  Transaction,
  MultisigTapscript,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  buildOffchainTx,
  networks,
  Wallet,
  Ramps,
  DefaultVtxo,
} from '@arkade-os/sdk';
import { hex, base64 } from '@scure/base';
import { loadKey } from '../src/keystore.js';

const ARK_URL = 'https://mutinynet.arkade.sh';
const ESPLORA_URL = 'https://mutinynet.com/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`STEP: ${name}`);
  console.log('='.repeat(60));
  try {
    const result = await fn();
    console.log(`\n  [PASS] ${name}`);
    return result;
  } catch (err) {
    console.error(`\n  [FAIL] ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function poll<T>(
  label: string,
  fn: () => Promise<T>,
  check: (result: T) => boolean,
  intervalMs = 3_000,
  timeoutMs = 120_000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (check(result)) return result;
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`    ${label} — waiting... (${elapsed}s)`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${label} timed out after ${timeoutMs / 1000}s`);
}

console.log('=== SPIKE-003: Escrow Round-Trip on Mutinynet ===\n');

// ─── Step 1: Server Connection ────────────────────────────────────────────────

const { arkProvider, indexerProvider, serverPubkey, serverInfo } = await runStep(
  '1. Server Connection',
  async () => {
    const ark = new RestArkProvider(ARK_URL);
    const idx = new RestIndexerProvider(ARK_URL);
    const info = await ark.getInfo();
    const decoded = hex.decode(info.signerPubkey);
    const sPubkey = decoded.length === 33 ? decoded.slice(1) : decoded;
    console.log(`  Connected to ${ARK_URL} (${info.network}, ${info.version})`);
    return { arkProvider: ark, indexerProvider: idx, serverPubkey: sPubkey, serverInfo: info };
  },
);

// ─── Step 2: Wallet / Identity Creation ───────────────────────────────────────

const { borrowerIdentity, lenderIdentity, borrowerPubkey, lenderPubkey, borrowerWallet } =
  await runStep('2. Wallet Creation', async () => {
    // Borrower: env var > encrypted keyfile > error (must be pre-funded)
    const envKey = process.env.BORROWER_PRIVATE_KEY;
    let borrowerId: SingleKey;
    let borrowerKeySource: string;

    if (envKey) {
      borrowerId = SingleKey.fromHex(envKey);
      borrowerKeySource = 'BORROWER_PRIVATE_KEY env var';
    } else {
      const stored = loadKey();
      if (stored) {
        borrowerId = SingleKey.fromHex(stored.privateKeyHex);
        borrowerKeySource = '~/.btc-wallet/key.enc';
      } else {
        throw new Error(
          'No borrower key found. Set BORROWER_PRIVATE_KEY env var or run `npm run keygen` first.\n' +
          'The borrower wallet must be pre-funded on Mutinynet.',
        );
      }
    }

    const lenderId = SingleKey.fromRandomBytes();
    const bPub = await borrowerId.xOnlyPublicKey();
    const lPub = await lenderId.xOnlyPublicKey();

    const bWallet = await Wallet.create({
      identity: borrowerId,
      arkServerUrl: ARK_URL,
      esploraUrl: ESPLORA_URL,
    });

    const boardingAddr = await bWallet.getBoardingAddress();
    console.log(`  Borrower: ${hex.encode(bPub).slice(0, 16)}... (from ${borrowerKeySource})`);
    console.log(`  Lender:   ${hex.encode(lPub).slice(0, 16)}... (random)`);
    console.log(`  Boarding:  ${boardingAddr}`);

    return {
      borrowerIdentity: borrowerId,
      lenderIdentity: lenderId,
      borrowerPubkey: bPub,
      lenderPubkey: lPub,
      borrowerWallet: bWallet,
    };
  });

// ─── Step 3: 4-Path Escrow Construction ───────────────────────────────────────

const { escrowScript, escrowAddress, pathAScript } = await runStep(
  '3. Escrow Construction (4-Path)',
  async () => {
    const pathA = MultisigTapscript.encode({
      pubkeys: [borrowerPubkey, lenderPubkey, serverPubkey],
    }).script;
    const pathB1 = MultisigTapscript.encode({
      pubkeys: [lenderPubkey, serverPubkey],
    }).script;
    const pathB2 = CLTVMultisigTapscript.encode({
      pubkeys: [lenderPubkey, serverPubkey],
      absoluteTimelock: BigInt(Math.floor(Date.now() / 1000)) + 604800n,
    }).script;
    const fourteenDaysSecs = Math.ceil((14 * 86400) / 512) * 512; // 1,209,856s — BIP68 multiple of 512
    const pathC = CSVMultisigTapscript.encode({
      pubkeys: [borrowerPubkey, serverPubkey],
      timelock: { type: 'seconds', value: fourteenDaysSecs },
    }).script;

    const script = new VtxoScript([pathA, pathB1, pathB2, pathC]);
    const address = script.address((networks as any).mutinynet.hrp, serverPubkey).encode();

    console.log(`  Path A:  ${pathA.length} bytes (borrower+lender+server)`);
    console.log(`  Path B1: ${pathB1.length} bytes (lender+server)`);
    console.log(`  Path B2: ${pathB2.length} bytes (lender+server+CLTV)`);
    console.log(`  Path C:  ${pathC.length} bytes (borrower+server+CSV)`);
    console.log(`  Escrow:  ${address}`);

    return { escrowScript: script, escrowAddress: address, pathAScript: pathA };
  },
);

// ─── Step 4: Fund Check + Onboard ───────────────────────────────────────────

await runStep('4. Fund Check + Onboard', async () => {
  const balance = await borrowerWallet.getBalance();
  const boarding = Number((balance as any).boarding?.total ?? 0);
  const available = Number((balance as any).available ?? 0);
  console.log(`  Current balance: boarding=${boarding}, available=${available} sats`);

  if (boarding > 0) {
    console.log(`  Boarding funds detected (${boarding} sats) — onboarding...`);
    const onboardTxid = await new Ramps(borrowerWallet).onboard(serverInfo.fees);
    console.log(`  Onboard txid: ${onboardTxid}`);

    const postBalance = await poll(
      'VTXO balance after onboard',
      () => borrowerWallet.getBalance(),
      (b: any) => Number(b.available ?? 0) > 0,
    );
    const postAvailable = Number((postBalance as any).available ?? 0);
    console.log(`  Available after onboard: ${postAvailable} sats`);
    return;
  }

  if (available > 0) {
    console.log(`  VTXOs available (${available} sats) — no boarding funds to onboard`);
    return;
  }

  // Neither boarding nor available — wallet is empty
  const boardingAddr = await borrowerWallet.getBoardingAddress();
  throw new Error(
    `Wallet has no funds.\n` +
    `  1. Go to https://faucet.mutinynet.com\n` +
    `  2. Send tBTC to: ${boardingAddr}\n` +
    `  3. Wait ~60 seconds for confirmation\n` +
    `  4. Re-run this script`,
  );
});

// ─── Step 5: Lock Collateral into Escrow ──────────────────────────────────────

let lockAmount = 0;

await runStep('5. Lock Collateral', async () => {
  const balance = await borrowerWallet.getBalance();
  const available = Number((balance as any).available ?? 0);
  lockAmount = available - 1000; // reserve for fees
  if (lockAmount <= 0) throw new Error(`Insufficient balance: ${available} sats`);

  console.log(`  Sending ${lockAmount} sats to escrow...`);
  const txid = await borrowerWallet.sendBitcoin({ address: escrowAddress, amount: lockAmount });
  console.log(`  Collateral locked: ${txid}`);
});

// Record borrower balance before release for verification
const preReleaseBalance = await borrowerWallet.getBalance();
const preReleaseAvailable = Number((preReleaseBalance as any).available ?? 0);
const preReleasePreconfirmed = Number((preReleaseBalance as any).preconfirmed ?? 0);
console.log(`\n  Pre-release borrower balance: available=${preReleaseAvailable}, preconfirmed=${preReleasePreconfirmed}`);

// ─── Step 6: Path A Collaborative Spend ───────────────────────────────────────

let spendTxid = '';

await runStep('6. Path A Collaborative Spend', async () => {
  // 6a. Query escrow VTXOs
  console.log('  6a. Querying escrow VTXOs...');
  const result = await poll(
    'Escrow VTXO',
    () =>
      indexerProvider.getVtxos({
        scripts: [hex.encode(escrowScript.pkScript)],
        spendableOnly: true,
      }),
    (r: any) => r.vtxos.length > 0,
  );

  const vtxo = result.vtxos[0];
  console.log(`  Found VTXO: txid=${vtxo.txid} vout=${vtxo.vout} value=${vtxo.value}`);

  // 6b. Decode server checkpoint script
  console.log('  6b. Decoding server checkpoint script...');
  const serverUnrollScript = CSVMultisigTapscript.decode(
    hex.decode(serverInfo.checkpointTapscript),
  );
  console.log('  Checkpoint script decoded');

  // 6c. Build recipient script — borrower's DefaultVtxo (wallet-compatible format)
  //     Must use DefaultVtxo.Script so the borrower's wallet auto-discovers the returned funds.
  //     Timelock comes from server's unilateralExitDelay (same as Wallet.create() uses internally).
  console.log('  6c. Building recipient script (DefaultVtxo — wallet-compatible)...');
  const exitDelay = BigInt(serverInfo.unilateralExitDelay);
  const exitTimelock = {
    value: exitDelay,
    type: (exitDelay < 512n ? 'blocks' : 'seconds') as 'blocks' | 'seconds',
  };
  const recipientScript = new DefaultVtxo.Script({
    pubKey: borrowerPubkey,
    serverPubKey: serverPubkey,
    csvTimelock: exitTimelock,
  });

  // 6d. Build offchain transaction
  console.log('  6d. Building offchain transaction...');
  const input = {
    txid: vtxo.txid,
    vout: vtxo.vout,
    value: vtxo.value,
    tapLeafScript: escrowScript.findLeaf(hex.encode(pathAScript)),
    tapTree: escrowScript.encode(),
  };

  const outputs = [
    {
      amount: BigInt(vtxo.value),
      script: recipientScript.pkScript,
    },
  ];

  const { arkTx, checkpoints } = buildOffchainTx([input], outputs, serverUnrollScript);
  console.log(`  Offchain tx built (${checkpoints.length} checkpoint(s))`);

  // 6e. Sign sequentially — borrower first, then lender
  console.log('  6e. Signing with borrower...');
  const psbt = arkTx.toPSBT();
  const txForBorrower = Transaction.fromPSBT(psbt);
  const signedByBorrower = await borrowerIdentity.sign(txForBorrower);

  console.log('  Signing with lender...');
  const txForLender = Transaction.fromPSBT(signedByBorrower.toPSBT());
  const signedByBoth = await lenderIdentity.sign(txForLender);

  // 6f. Submit to server (server co-signs as 3rd party)
  console.log('  6f. Submitting to Arkade server...');
  const checkpointPsbts = checkpoints.map((c: any) => c.toPSBT());
  let submitResult: any;
  try {
    submitResult = await arkProvider.submitTx(
      base64.encode(signedByBoth.toPSBT()),
      checkpointPsbts.map((c: Uint8Array) => base64.encode(c)),
    );
  } catch (err: any) {
    console.error('  submitTx FAILED — logging debug info:');
    console.error(`  Error: ${err.message}`);
    console.error(`  Signed PSBT (hex): ${hex.encode(signedByBoth.toPSBT()).slice(0, 120)}...`);
    throw err;
  }
  const { arkTxid, signedCheckpointTxs } = submitResult;
  console.log(`  Server accepted: ${arkTxid}`);

  // 6g. Sign checkpoints with both identities
  console.log(`  6g. Signing ${signedCheckpointTxs.length} checkpoint(s)...`);
  const finalCheckpoints = await Promise.all(
    signedCheckpointTxs.map(async (cpB64: string) => {
      const cpTx = Transaction.fromPSBT(base64.decode(cpB64));
      const cpBorrower = await borrowerIdentity.sign(cpTx, [0]);
      const cpBoth = await lenderIdentity.sign(
        Transaction.fromPSBT(cpBorrower.toPSBT()),
        [0],
      );
      return base64.encode(cpBoth.toPSBT());
    }),
  );
  console.log('  Checkpoints signed');

  // 6h. Finalize
  console.log('  6h. Finalizing transaction...');
  await arkProvider.finalizeTx(arkTxid, finalCheckpoints);

  spendTxid = arkTxid;
  console.log(`\n  Path A spend executed: ${arkTxid}`);
});

// ─── Step 7: Verification ─────────────────────────────────────────────────────

await runStep('7. Verification', async () => {
  // 7a. Escrow is drained — the definitive proof that the spend worked
  console.log('  7a. Checking escrow is drained...');
  const escrowResult = await poll(
    'Escrow drain',
    () =>
      indexerProvider.getVtxos({
        scripts: [hex.encode(escrowScript.pkScript)],
        spendableOnly: true,
      }),
    (r: any) => r.vtxos.length === 0,
    5_000,
    120_000,
  );
  console.log(`  Escrow drained: ${escrowResult.vtxos.length} VTXOs remaining`);

  // 7b. Borrower balance — poll until wallet sees the returned funds
  console.log('  7b. Checking borrower wallet balance...');
  const postBalance = await poll(
    'Borrower balance increase',
    () => borrowerWallet.getBalance(),
    (b: any) => {
      const available = Number(b.available ?? 0);
      const preconfirmed = Number(b.preconfirmed ?? 0);
      return (available + preconfirmed) > (preReleaseAvailable + preReleasePreconfirmed);
    },
    5_000,
    120_000,
  );
  const postAvailable = Number((postBalance as any).available ?? 0);
  const postPreconfirmed = Number((postBalance as any).preconfirmed ?? 0);
  const postTotal = postAvailable + postPreconfirmed;
  const preTotal = preReleaseAvailable + preReleasePreconfirmed;
  console.log(`  Borrower balance: available=${postAvailable}, preconfirmed=${postPreconfirmed} sats`);
  console.log(`  (Pre-release was: available=${preReleaseAvailable}, preconfirmed=${preReleasePreconfirmed})`);
  console.log(`  Balance increased by ${postTotal - preTotal} sats — collateral returned to wallet`);
});

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log('SPIKE-003 COMPLETE — full escrow round-trip on Mutinynet');
console.log('='.repeat(60));
console.log(`  Lock amount:   ${lockAmount} sats`);
console.log(`  Spend txid:    ${spendTxid}`);
console.log('  Steps 1-7:    ALL PASS');
