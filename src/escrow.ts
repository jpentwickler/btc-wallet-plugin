/**
 * 4-path escrow construction, collateral locking, PSBT signing, and VTXO verification.
 *
 * Reuses validated patterns from reference/spike002-release-test.ts (SPIKE-002)
 * and reference/escrow-test.ts (SPIKE-001).
 */

import {
  MultisigTapscript,
  CSVMultisigTapscript,
  VtxoScript,
  DefaultVtxo,
  Transaction,
  buildOffchainTx,
  networks,
} from "@arkade-os/sdk";
import { hex, base64 } from "@scure/base";

import type { ArkadeWallet } from "./wallet.js";
import type {
  BuildEscrowParams,
  BuildEscrowResult,
  LockCollateralParams,
  LockCollateralResult,
  SignReleaseParams,
  SignReleaseResult,
  SignCheckpointsParams,
  SignCheckpointsResult,
  VerifyVtxoParams,
  VerifyVtxoResult,
} from "./types.js";

export class EscrowManager {
  private wallet: ArkadeWallet;

  constructor(wallet: ArkadeWallet) {
    this.wallet = wallet;
  }

  // ─── build_escrow ──────────────────────────────────────────────────────────

  async buildEscrow(params: BuildEscrowParams): Promise<BuildEscrowResult> {
    const borrowerPub = hex.decode(params.borrowerPubkey);
    const lenderPub = hex.decode(params.lenderPubkey);

    // Use server pubkey from params if provided, otherwise from connected server
    const serverPub = params.serverPubkey
      ? hex.decode(params.serverPubkey)
      : this.wallet.serverPubkey;

    // ADR-004: all 4 paths use plain MultisigTapscript with no on-chain timelocks.
    // Timing enforcement (LTV, default grace, lender-cooperation grace) is server-gated
    // by the Protocol Service state machine. cltvDays/csvDays params are accepted for
    // backward compatibility but ignored — see project memory project_arkade_csv_cltv_rule.

    // Path A: cooperative release — borrower + lender + server (3-of-3)
    const pathA = MultisigTapscript.encode({
      pubkeys: [borrowerPub, lenderPub, serverPub],
    }).script;

    // Path B1: emergency liquidation — lender + server (2-of-2, server-gated by LTV)
    const pathB1 = MultisigTapscript.encode({
      pubkeys: [lenderPub, serverPub],
    }).script;

    // Path B2: default backstop — lender + server (2-of-2, server-gated by default state)
    const pathB2 = MultisigTapscript.encode({
      pubkeys: [lenderPub, serverPub],
    }).script;

    // Path C: borrower safety exit — borrower + server (2-of-2, server-gated by repaid + lender-unresponsive state)
    const pathC = MultisigTapscript.encode({
      pubkeys: [borrowerPub, serverPub],
    }).script;

    // Combine into VtxoScript (path order A=0, B1=1, B2=2, C=3 is load-bearing — decoder + BACK-014 gate rely on it)
    const escrowScript = new VtxoScript([pathA, pathB1, pathB2, pathC]);

    // Derive escrow address
    const hrp = this.wallet.getNetworkHrp();
    const escrowAddress = escrowScript.address(hrp, serverPub).encode();

    return {
      escrowScript: hex.encode(escrowScript.encode()),
      escrowAddress,
      paths: {
        A: "borrower + lender + server (cooperative, anytime)",
        B1: "lender + server (LTV-gated by server)",
        B2: "lender + server (default-state-gated by server)",
        C: "borrower + server (repaid-state-gated by server)",
      },
    };
  }

  // ─── lock_collateral ───────────────────────────────────────────────────────

  async lockCollateral(params: LockCollateralParams): Promise<LockCollateralResult> {
    const wallet = this.wallet.getWallet();

    // Decode the escrow script to get the address
    const escrowScriptBytes = hex.decode(params.escrowScript);
    const escrowScript = VtxoScript.decode(escrowScriptBytes);
    const hrp = this.wallet.getNetworkHrp();
    const escrowAddress = escrowScript
      .address(hrp, this.wallet.serverPubkey)
      .encode();

    // Send BTC to the escrow address
    const txid = await wallet.sendBitcoin({
      address: escrowAddress,
      amount: params.amountSats,
    });

    const explorerUrl = `${this.wallet.config.arkadeExplorer}/tx/${txid}`;

    return {
      txid,
      amountSats: params.amountSats,
      escrowAddress,
      explorerUrl,
    };
  }

  // ─── sign_release ──────────────────────────────────────────────────────────

  async signRelease(params: SignReleaseParams): Promise<SignReleaseResult> {
    const identity = this.wallet.getIdentity();
    const pubkey = await identity.xOnlyPublicKey();

    // Decode escrow script
    const escrowScriptBytes = hex.decode(params.escrowScript);
    const escrowScript = VtxoScript.decode(escrowScriptBytes);

    // Get server checkpoint script for offchain tx
    const serverUnrollScript = CSVMultisigTapscript.decode(
      hex.decode(this.wallet.serverInfo.checkpointTapscript),
    );

    if (params.psbt) {
      // ── Second signer: add signature to existing PSBT ──
      const existingTx = Transaction.fromPSBT(base64.decode(params.psbt));
      const signed = await identity.sign(existingTx);
      const signedPsbt = base64.encode(signed.toPSBT());

      return {
        psbt: signedPsbt,
        signedBy: hex.encode(pubkey),
        path: params.path,
        complete: this.isPathComplete(params.path, 2), // 2nd signer
      };
    }

    // ── First signer: build new transaction and sign ──

    // Find the escrow VTXO to spend
    const vtxoResult = await this.wallet.indexerProvider.getVtxos({
      scripts: [hex.encode(escrowScript.pkScript)],
      spendableOnly: true,
    });

    if (vtxoResult.vtxos.length === 0) {
      throw new Error("No spendable VTXOs found at escrow address");
    }

    const vtxo = vtxoResult.vtxos[0];

    // Get the leaf script for the specified path
    const pathScript = this.getPathScript(escrowScript, params.path);
    const leafHex = hex.encode(pathScript);

    // Build input
    const input = {
      txid: vtxo.txid,
      vout: vtxo.vout,
      value: vtxo.value,
      tapLeafScript: escrowScript.findLeaf(leafHex),
      tapTree: escrowScript.encode(),
    };

    // Build recipient script (standard 2-of-2 with server)
    const recipientPubkey = hex.decode(params.recipientAddress.startsWith("tark")
      ? hex.encode(pubkey) // If recipient is an arkade address, use our pubkey
      : params.recipientAddress);

    // Build recipient VTXO using DefaultVtxo.Script (2-leaf: forfeit + exit)
    // This matches the wallet SDK's own script derivation so the recipient
    // wallet recognizes the VTXO in its balance.
    const recipientScript = new DefaultVtxo.Script({
      pubKey: recipientPubkey,
      serverPubKey: this.wallet.serverPubkey,
      csvTimelock: this.wallet.getExitTimelock(),
    });

    // Build outputs
    const outputs: Array<{ amount: bigint; script: Uint8Array }> = [
      {
        amount: BigInt(params.amountSats),
        script: recipientScript.pkScript,
      },
    ];

    // Add change output for two-output transactions (fair split)
    if (params.changeAddress && params.changeSats) {
      const changePubkey = hex.decode(params.changeAddress);
      const changeScript = new DefaultVtxo.Script({
        pubKey: changePubkey,
        serverPubKey: this.wallet.serverPubkey,
        csvTimelock: this.wallet.getExitTimelock(),
      });
      outputs.push({
        amount: BigInt(params.changeSats),
        script: changeScript.pkScript,
      });
    }

    // Build offchain transaction
    const { arkTx } = buildOffchainTx([input], outputs, serverUnrollScript);

    // Sign with our identity
    const psbt = arkTx.toPSBT();
    const txToSign = Transaction.fromPSBT(psbt);
    const signed = await identity.sign(txToSign);
    const signedPsbt = base64.encode(signed.toPSBT());

    return {
      psbt: signedPsbt,
      signedBy: hex.encode(pubkey),
      path: params.path,
      complete: this.isPathComplete(params.path, 1), // 1st signer
    };
  }

  // ─── verify_vtxo ──────────────────────────────────────────────────────────

  async verifyVtxo(params: VerifyVtxoParams): Promise<VerifyVtxoResult> {
    const explorerUrl = `${this.wallet.config.arkadeExplorer}/tx/${params.txid}`;
    const vout = params.vout ?? 0;

    try {
      const result = await this.wallet.indexerProvider.getVtxos({
        outpoints: [{ txid: params.txid, vout }],
      });

      if (result.vtxos.length === 0) {
        return { exists: false, valueSats: 0, script: "", explorerUrl };
      }

      const vtxo = result.vtxos[0];
      const valueSats = Number(vtxo.value);

      return {
        exists: true,
        valueSats,
        script: `${params.txid}:${vout}`,
        explorerUrl,
      };
    } catch {
      return { exists: false, valueSats: 0, script: "", explorerUrl };
    }
  }

  // ─── sign_checkpoints ──────────────────────────────────────────────────────

  async signCheckpoints(params: SignCheckpointsParams): Promise<SignCheckpointsResult> {
    const identity = this.wallet.getIdentity();
    const pubkey = await identity.xOnlyPublicKey();

    const signedCheckpoints = await Promise.all(
      params.checkpointPsbts.map(async (cpB64: string) => {
        const cpTx = Transaction.fromPSBT(base64.decode(cpB64));
        const signed = await identity.sign(cpTx, [0]);
        return base64.encode(signed.toPSBT());
      }),
    );

    return {
      signedCheckpoints,
      signedBy: hex.encode(pubkey),
      count: signedCheckpoints.length,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Extract the leaf script for a given path from a 4-path escrow VtxoScript.
   * Path order: [A, B1, B2, C]
   */
  private getPathScript(escrowScript: VtxoScript, path: string): Uint8Array {
    // Use escrowScript.scripts (raw scripts in constructor order) instead of
    // exitPaths() which filters out non-CSV/CLTV leaves (Path A and B1).
    const scripts = escrowScript.scripts;
    const pathIndex: Record<string, number> = {
      A: 0,
      B1: 1,
      B2: 2,
      C: 3,
    };
    const idx = pathIndex[path];
    if (idx === undefined) {
      throw new Error(`Invalid path: ${path}. Must be A, B1, B2, or C.`);
    }
    if (!scripts[idx]) {
      throw new Error(`Path ${path} not found in escrow script (${scripts.length} scripts available)`);
    }
    return scripts[idx];
  }

  /**
   * Check if a path has all required signatures (excluding server).
   * Path A: needs 2 (borrower + lender), Path B1/B2: needs 1 (lender), Path C: needs 1 (borrower).
   */
  private isPathComplete(path: string, signerCount: number): boolean {
    const requiredSigs: Record<string, number> = {
      A: 2,  // borrower + lender (server signs on submit)
      B1: 1, // lender only (server signs on submit)
      B2: 1, // lender only (server signs on submit)
      C: 1,  // borrower only (server signs on submit)
    };
    return signerCount >= (requiredSigs[path] ?? 1);
  }
}
