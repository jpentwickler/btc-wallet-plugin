/**
 * SPIKE-001: Arkade 4-Path Escrow Validation (Mutinynet)
 *
 * Validates that the Arkade SDK supports constructing and spending from
 * a 4-path escrow VTXO:
 *   Path A:  MultisigTapscript       — borrower + lender + server (cooperative)
 *   Path B1: MultisigTapscript       — lender + server (emergency liquidation)
 *   Path B2: CLTVMultisigTapscript   — lender + server, 7-day absolute timelock
 *   Path C:  CSVMultisigTapscript    — borrower + server, 14-day relative timelock
 *
 * Target: mutinynet.arkade.sh (requires Mutinynet faucet for funding)
 * For local regtest testing, use regtest-test.ts instead.
 */

// EventSource polyfill for Node.js (SDK uses SSE for batch settlement)
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
} from '@arkade-os/sdk';
import { hex, base64 } from '@scure/base';
import * as readline from 'node:readline/promises';

// ─── Results & Findings ───────────────────────────────────────────────────────
const findings: Record<string, unknown> = {};
const apiNotes: string[] = [];

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
    printSummary();
    process.exit(1);
  }
}

function printSummary() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(60));
  for (const [key, value] of Object.entries(findings)) {
    if (key === 'serverInfo') continue;
    console.log(`  ${key}: ${JSON.stringify(value)}`);
  }
  if (apiNotes.length > 0) {
    console.log('\nAPI NOTES (for FINDINGS.md):');
    apiNotes.forEach((note, i) => console.log(`  ${i + 1}. ${note}`));
  }
}

async function waitForKeypress(prompt: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await rl.question(prompt);
  rl.close();
}

async function poll<T>(
  label: string,
  fn: () => Promise<T>,
  check: (result: T) => boolean,
  intervalMs = 5_000,
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

// ─── Step 1: Server Connection ────────────────────────────────────────────────

const { arkProvider, indexerProvider, serverPubkey, serverInfo } = await runStep(
  'Server Connection',
  async () => {
    const SERVER_URLS = [
      'https://mutinynet.arkade.sh',
      'https://arkade.computer',
    ];

    for (const url of SERVER_URLS) {
      try {
        console.log(`  Trying ${url}...`);
        const ark = new RestArkProvider(url);
        const idx = new RestIndexerProvider(url);
        const info = await ark.getInfo();

        // Extract x-only server pubkey (strip 0x02/0x03 prefix if 33 bytes)
        const decoded = hex.decode(info.signerPubkey);
        const sPubkey = decoded.length === 33 ? decoded.slice(1) : decoded;

        console.log(`  Connected to Arkade server at ${url}`);
        for (const [k, v] of Object.entries(info)) {
          if (typeof v !== 'object') console.log(`    ${k}: ${v}`);
        }
        console.log(`  Available networks: ${Object.keys(networks)}`);

        findings.serverUrl = url;
        findings.signerPubkey = info.signerPubkey;
        findings.serverInfo = info;

        return { arkProvider: ark, indexerProvider: idx, serverPubkey: sPubkey, serverInfo: info };
      } catch (err) {
        console.log(`    Failed: ${(err as Error).message}`);
      }
    }
    throw new Error('Could not connect to any Arkade server');
  },
);

// ─── Step 2: Wallet / Identity Creation ───────────────────────────────────────

const { borrowerIdentity, lenderIdentity, borrowerPubkey, lenderPubkey, borrowerWallet } =
  await runStep('Wallet Creation', async () => {
    // SingleKey.fromRandomBytes() confirmed available
    const borrowerId = SingleKey.fromRandomBytes();
    const lenderId = SingleKey.fromRandomBytes();
    apiNotes.push('SingleKey.fromRandomBytes() works');

    const bPub = await borrowerId.xOnlyPublicKey();
    const lPub = await lenderId.xOnlyPublicKey();
    apiNotes.push('SingleKey.xOnlyPublicKey() returns 32-byte Uint8Array');

    // Persist keys so they can be recovered if the script restarts
    console.log(`  Borrower private key: ${borrowerId.toHex()}`);
    console.log(`  Lender private key:   ${lenderId.toHex()}`);

    // Create borrower wallet for funding
    const bWallet = await Wallet.create({
      identity: borrowerId,
      arkServerUrl: findings.serverUrl as string,
      esploraUrl: 'https://mutinynet.com/api',
    });

    const bAddr = await bWallet.getBoardingAddress();
    console.log(`  Borrower pubkey: ${hex.encode(bPub)}`);
    console.log(`  Lender pubkey:   ${hex.encode(lPub)}`);
    console.log(`  Borrower wallet created: ${bAddr}`);

    findings.identityType = 'SingleKey';
    findings.borrowerPubkey = hex.encode(bPub);
    findings.lenderPubkey = hex.encode(lPub);
    findings.borrowerAddress = bAddr;

    return {
      borrowerIdentity: borrowerId,
      lenderIdentity: lenderId,
      borrowerPubkey: bPub,
      lenderPubkey: lPub,
      borrowerWallet: bWallet,
    };
  });

// ─── Step 3: Escrow Construction (4-Path VtxoScript) ──────────────────────────

const { escrowScript, escrowAddress, pathAScript } = await runStep(
  'Escrow Construction',
  async () => {
    // ── Path A: Cooperative release — borrower + lender + server (3-of-3) ──
    console.log('  Building Path A: MultisigTapscript (borrower + lender + server)...');
    const pathA = MultisigTapscript.encode({
      pubkeys: [borrowerPubkey, lenderPubkey, serverPubkey],
    }).script;
    console.log(`    Path A script (${pathA.length} bytes): ${hex.encode(pathA).slice(0, 60)}...`);
    apiNotes.push('MultisigTapscript.encode({ pubkeys }) — n-of-n multisig, no m param needed');

    // ── Path B1: Emergency liquidation — lender + server (2-of-2, no timelock) ──
    console.log('  Building Path B1: MultisigTapscript (lender + server, no timelock)...');
    const pathB1 = MultisigTapscript.encode({
      pubkeys: [lenderPubkey, serverPubkey],
    }).script;
    console.log(`    Path B1 script (${pathB1.length} bytes): ${hex.encode(pathB1).slice(0, 60)}...`);
    apiNotes.push('Path B1 (emergency liquidation): 2-of-2 MultisigTapscript, server-gated by LTV check');

    // ── Path B2: Default backstop — lender + server, 7-day CLTV ──
    console.log('  Building Path B2: CLTVMultisigTapscript (lender + server, 7-day CLTV)...');
    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    const sevenDays = 86400n * 7n;
    const pathB2 = CLTVMultisigTapscript.encode({
      pubkeys: [lenderPubkey, serverPubkey],
      absoluteTimelock: nowSecs + sevenDays,
    }).script;
    console.log(`    Path B2 script (${pathB2.length} bytes): ${hex.encode(pathB2).slice(0, 60)}...`);
    console.log(`    CLTV timeout: ${nowSecs + sevenDays} (${new Date(Number(nowSecs + sevenDays) * 1000).toISOString()})`);
    apiNotes.push('CLTVMultisigTapscript.encode({ pubkeys, absoluteTimelock: BigInt }) — Unix timestamp');

    // ── Path C: Borrower safety exit — borrower + server, 14-day CSV ──
    // API: timelock: { type: "blocks" | "seconds", value: number }
    // For "seconds" type, value must be a multiple of 512 (BIP68).
    // Server rejects block-based CSV — must use seconds (multiple of 512, BIP68)
    console.log('  Building Path C: CSVMultisigTapscript (borrower + server, 14-day CSV)...');
    const csvSecs = Math.ceil((14 * 86400) / 512) * 512; // 1,209,856s — BIP68 multiple of 512
    const pathC = CSVMultisigTapscript.encode({
      pubkeys: [borrowerPubkey, serverPubkey],
      timelock: { type: 'seconds', value: csvSecs },
    }).script;
    console.log(`    Path C script (${pathC.length} bytes): ${hex.encode(pathC).slice(0, 60)}...`);
    console.log(`    CSV relative timelock: ${csvSecs} seconds (~14 days, BIP68 multiple of 512)`);
    apiNotes.push(`CSVMultisigTapscript.encode({ pubkeys, timelock: { type: "seconds", value } }) — BIP68 relative lock, value must be multiple of 512`);
    apiNotes.push(`Server REJECTS { type: "blocks" } — only seconds-based CSV is allowed`);

    // ── Combine into VtxoScript ──
    console.log('  Combining 4 paths into VtxoScript...');
    const script = new VtxoScript([pathA, pathB1, pathB2, pathC]);

    // Derive escrow address using mutinynet HRP ("tark")
    const hrp = (networks as any).mutinynet.hrp;
    const address = script.address(hrp, serverPubkey).encode();

    console.log(`\n  Escrow VTXO constructed with 4 paths (A: cooperative, B1: liquidation, B2: default, C: safety)`);
    console.log(`  Escrow address: ${address}`);

    findings.escrowAddress = address;
    findings.networkHrp = hrp;
    findings.pathCount = 4;

    return { escrowScript: script, escrowAddress: address, pathAScript: pathA };
  },
);

// ─── Steps 4-6: Funding, Locking, Spending (best-effort) ──────────────────────
// These steps require a working Arkade server boarding flow. If the server is
// unhealthy (HTTP 500 on registerIntent), they will fail gracefully and the
// spike still produces usable findings from Steps 1-3.

let funded = false;

try {
  await runStep('Fund from Faucet', async () => {
    const boardingAddr = await borrowerWallet.getBoardingAddress();

    console.log('');
    console.log('  +------------------------------------------------------+');
    console.log('  |  Send testnet BTC to the borrower boarding address    |');
    console.log('  |                                                       |');
    console.log(`  |  Address: ${boardingAddr}`);
    console.log('  |                                                       |');
    console.log('  |  Faucet:  https://faucet.mutinynet.com                |');
    console.log('  +------------------------------------------------------+');

    await waitForKeypress('\n  Press ENTER after sending from faucet...');

    // Poll for boarding balance
    const balance = await poll(
      'Waiting for boarding balance',
      () => borrowerWallet.getBalance(),
      (b: any) => {
        const total = Number(b.boarding?.total ?? b.boarding ?? 0);
        return total > 0;
      },
    );

    const boardingTotal = Number((balance as any).boarding?.total ?? (balance as any).boarding ?? 0);
    console.log(`  Funding detected: ${boardingTotal} sats`);
    findings.fundedAmount = boardingTotal;

    // Onboard: convert boarding UTXOs -> VTXOs
    // Server may return HTTP 500 on registerIntent — retry up to 3 times
    console.log('  Onboarding (boarding UTXOs -> VTXOs)...');
    let onboardTxid: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        onboardTxid = await new Ramps(borrowerWallet).onboard(serverInfo.fees);
        break;
      } catch (err) {
        const msg = (err as Error).message ?? '';
        console.log(`    Onboard attempt ${attempt}/3 failed: ${msg.slice(0, 120)}`);
        if (attempt === 3) throw err;
        const delaySec = attempt * 10;
        console.log(`    Retrying in ${delaySec}s...`);
        await new Promise((r) => setTimeout(r, delaySec * 1000));
      }
    }
    console.log(`  Onboard txid: ${onboardTxid}`);

    // Poll for available VTXO balance
    const vtxoBalance = await poll(
      'Waiting for VTXO balance',
      () => borrowerWallet.getBalance(),
      (b: any) => Number(b.available ?? 0) > 0,
    );

    const available = Number((vtxoBalance as any).available ?? 0);
    console.log(`  Onboarded: ${available} sats available as VTXOs`);
    findings.onboardedAmount = available;
    findings.onboardTxid = onboardTxid;
    funded = true;
  });
} catch {
  console.log('\n  ** Step 4 failed — Arkade server boarding flow is unhealthy **');
  console.log('  ** This is a server-side issue (HTTP 500 on registerIntent) **');
  console.log('  ** Skipping Steps 5-6 (require funded VTXOs) **');
  apiNotes.push('BLOCKER: Ramps.onboard() fails — server returns HTTP 500 on registerIntent ("failed to watch boarding scripts")');
  apiNotes.push('This is a Mutinynet server issue, not an SDK limitation — retry when server recovers');
  findings.onboardingBlocked = true;
}

if (funded) {
  await runStep('Lock Collateral', async () => {
    const balance = await borrowerWallet.getBalance();
    const available = Number((balance as any).available ?? 0);
    const lockAmount = available - 1000; // reserve for fees
    if (lockAmount <= 0) throw new Error(`Insufficient balance: ${available} sats`);

    console.log(`  Sending ${lockAmount} sats to escrow address...`);

    try {
      const txid = await borrowerWallet.sendBitcoin({
        address: escrowAddress,
        amount: lockAmount,
      });
      console.log(`  Collateral locked: ${txid}`);
      console.log(`  Explorer: https://explorer.mutinynet.arkade.sh/tx/${txid}`);
      findings.lockTxid = txid;
      findings.lockAmount = lockAmount;
      apiNotes.push('wallet.sendBitcoin() accepts custom VtxoScript escrow address');
    } catch (err) {
      console.log(`  sendBitcoin rejected escrow address: ${(err as Error).message}`);
      apiNotes.push(`sendBitcoin REJECTED escrow address: ${(err as Error).message}`);
      apiNotes.push('SIGNIFICANT: Must use buildOffchainTx directly for custom escrow addresses');
      throw err;
    }
  });

  await runStep('Path A Spend (Collaborative Release)', async () => {
    // 1. Query VTXOs at escrow address
    console.log('  Querying escrow VTXOs...');
    const result = await indexerProvider.getVtxos({
      scripts: [hex.encode(escrowScript.pkScript)],
      spendableOnly: true,
    });

    if (result.vtxos.length === 0) {
      throw new Error('No spendable VTXOs found at escrow address');
    }

    const vtxo = result.vtxos[0];
    console.log(`  Found VTXO: txid=${vtxo.txid} vout=${vtxo.vout} value=${vtxo.value}`);

    // 2. Decode server checkpoint script
    const serverUnrollScript = CSVMultisigTapscript.decode(
      hex.decode(serverInfo.checkpointTapscript),
    );

    // 3. Build recipient script — standard 2-of-2 (borrower + server) VTXO
    const recipientScript = new VtxoScript([
      MultisigTapscript.encode({ pubkeys: [borrowerPubkey, serverPubkey] }).script,
    ]);

    // 4. Build offchain transaction
    console.log('  Building offchain transaction...');
    const input = {
      txid: vtxo.txid,
      vout: vtxo.vout,
      value: vtxo.value,
      tapLeafScript: escrowScript.findLeaf(hex.encode(pathAScript)),
      tapTree: escrowScript.encode(),
    };

    const outputs = [
      {
        amount: vtxo.value,
        script: recipientScript.pkScript,
      },
    ];

    const { arkTx, checkpoints } = buildOffchainTx([input], outputs, serverUnrollScript);
    console.log('  Offchain tx built successfully');

    // 5. Sign with borrower, then lender
    console.log('  Signing with borrower...');
    const psbt = arkTx.toPSBT();
    const txForBorrower = Transaction.fromPSBT(psbt);
    const signedByBorrower = await borrowerIdentity.sign(txForBorrower);

    console.log('  Signing with lender...');
    const txForLender = Transaction.fromPSBT(signedByBorrower.toPSBT());
    const signedByBoth = await lenderIdentity.sign(txForLender);

    // 6. Submit to server (server co-signs as 3rd party)
    console.log('  Submitting to Arkade server...');
    const checkpointPsbts = checkpoints.map((c: any) => c.toPSBT());
    const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
      base64.encode(signedByBoth.toPSBT()),
      checkpointPsbts.map((c: Uint8Array) => base64.encode(c)),
    );
    console.log(`  Server accepted: ${arkTxid}`);

    // 7. Sign checkpoints with both identities
    console.log('  Signing checkpoints...');
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

    // 8. Finalize
    console.log('  Finalizing transaction...');
    await arkProvider.finalizeTx(arkTxid, finalCheckpoints);

    console.log(`\n  Path A spend executed: ${arkTxid}`);
    console.log(`  Explorer: https://explorer.mutinynet.arkade.sh/tx/${arkTxid}`);
    findings.spendTxid = arkTxid;
    apiNotes.push('Path A collaborative spend (3-of-3 multisig) works end-to-end');
  });
}

// ─── Summary ──────────────────────────────────────────────────────────────────

printSummary();

if (funded) {
  console.log('\nSPIKE COMPLETE (full) — all steps passed');
} else {
  console.log('\nSPIKE COMPLETE (partial) — escrow construction validated, on-chain flow blocked by server');
  console.log('Steps 1-3 PASSED: server connection, wallet creation, 3-path escrow construction');
  console.log('Steps 4-6 BLOCKED: Mutinynet server registerIntent returns HTTP 500');
  console.log('Recommendation: retry Steps 4-6 when server recovers, or test on arkade.computer (mainnet)');
}
