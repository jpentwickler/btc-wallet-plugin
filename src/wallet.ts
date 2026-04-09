/**
 * Arkade wallet wrapper — identity management, balance, address, VTXOs.
 *
 * Reuses validated patterns from reference/escrow-test.ts and
 * reference/regtest-test.ts (SPIKE-001).
 */

// EventSource polyfill for Node.js — SDK uses SSE for batch settlement
import { EventSource } from "eventsource";
(globalThis as any).EventSource = EventSource;

import {
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
  Ramps,
  networks,
  InMemoryWalletRepository,
  InMemoryContractRepository,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

import { saveKey, loadKey, getKeyfilePath } from "./keystore.js";
import type {
  WalletConfig,
  CreateWalletResult,
  GetBalanceResult,
  GetAddressResult,
  OnboardResult,
  GetVtxosResult,
} from "./types.js";

export class ArkadeWallet {
  private identity: SingleKey | null = null;
  private wallet: Wallet | null = null;
  private address: string | null = null;

  readonly arkProvider: RestArkProvider;
  readonly indexerProvider: RestIndexerProvider;
  readonly config: WalletConfig;

  // Set after init()
  serverPubkey!: Uint8Array;
  serverInfo!: any;

  constructor(config: WalletConfig) {
    this.config = config;
    this.arkProvider = new RestArkProvider(config.arkadeServer);
    this.indexerProvider = new RestIndexerProvider(config.arkadeServer);
  }

  /** Connect to the Arkade server and fetch server info. */
  async init(): Promise<void> {
    this.serverInfo = await this.arkProvider.getInfo();

    // Extract x-only server pubkey (strip 0x02/0x03 prefix if 33 bytes)
    const decoded = hex.decode(this.serverInfo.signerPubkey);
    this.serverPubkey = decoded.length === 33 ? decoded.slice(1) : decoded;
  }

  /** Get the identity, throw if wallet not created. */
  getIdentity(): SingleKey {
    if (!this.identity) {
      throw new Error("Wallet not created. Call create_wallet first.");
    }
    return this.identity;
  }

  /** Get the Arkade SDK Wallet instance. */
  getWallet(): Wallet {
    if (!this.wallet) {
      throw new Error("Wallet not created. Call create_wallet first.");
    }
    return this.wallet;
  }

  /** Get the exit timelock matching the SDK wallet's DefaultVtxo derivation. */
  getExitTimelock(): { value: bigint; type: "blocks" | "seconds" } {
    const delay = BigInt(this.serverInfo.unilateralExitDelay);
    return {
      value: delay,
      type: delay < 512n ? "blocks" : "seconds",
    };
  }

  /** Get the network HRP for address derivation. */
  getNetworkHrp(): string {
    return (networks as any)[this.config.arkadeNetwork]?.hrp ?? "tark";
  }

  /** Get the esplora URL for the configured network. */
  private getEsploraUrl(): string {
    if (this.config.esploraUrl) {
      return this.config.esploraUrl;
    }
    if (this.config.arkadeNetwork === "regtest") {
      // Local regtest uses chopsticks on port 3000
      const url = new URL(this.config.arkadeServer);
      return `${url.protocol}//${url.hostname}:3000`;
    }
    // Mutinynet uses the public esplora
    return "https://mutinynet.com/api";
  }

  // ─── Tool Implementations ──────────────────────────────────────────────────

  async createWallet(privateKey?: string): Promise<CreateWalletResult> {
    // Priority: param > env var > encrypted keyfile > auto-generate
    const key = privateKey ?? this.config.walletPrivateKey;
    let restored = false;

    if (key) {
      this.identity = SingleKey.fromHex(key);
      restored = true;
    } else {
      // Try loading from encrypted keyfile
      const stored = loadKey();
      if (stored) {
        this.identity = SingleKey.fromHex(stored.privateKeyHex);
        restored = true;
        console.error(`Wallet restored from ${getKeyfilePath()}`);
      } else {
        this.identity = SingleKey.fromRandomBytes();
      }
    }

    const pubkey = await this.identity.xOnlyPublicKey();

    // Auto-persist new keys to encrypted keyfile
    if (!restored) {
      const keyHex = this.identity.toHex();
      const path = saveKey(keyHex, this.config.arkadeNetwork);
      console.error(`Wallet key saved to ${path}`);
    }

    // Create Arkade SDK Wallet for balance/send operations
    this.wallet = await Wallet.create({
      identity: this.identity,
      arkServerUrl: this.config.arkadeServer,
      esploraUrl: this.getEsploraUrl(),
      storage: {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
      },
    });

    this.address = await this.wallet.getBoardingAddress();

    return {
      address: this.address,
      pubkey: hex.encode(pubkey),
      network: this.config.arkadeNetwork,
      restored,
    };
  }

  async getBalance(): Promise<GetBalanceResult> {
    const wallet = this.getWallet();
    const balance = await wallet.getBalance();
    const bal = balance as any;

    const available = Number(bal.available ?? 0);
    const settled = Number(bal.settled ?? 0);
    const preconfirmed = Number(bal.preconfirmed ?? 0);
    const boarding = Number(bal.boarding?.total ?? 0);
    const total = available + boarding;

    // Count VTXOs using SDK's Wallet.getVtxos()
    let vtxoCount = 0;
    try {
      const vtxos = await wallet.getVtxos({ withRecoverable: false });
      vtxoCount = vtxos.length;
    } catch {
      // best-effort
    }

    return {
      available,
      settled,
      preconfirmed,
      boarding,
      total,
      address: this.address ?? "",
      vtxoCount,
    };
  }

  async onboard(): Promise<OnboardResult> {
    const wallet = this.getWallet();

    // Check boarding balance first
    const preBal = await wallet.getBalance();
    const boardingSats = Number((preBal as any).boarding?.total ?? 0);
    if (boardingSats === 0) {
      throw new Error("No boarding funds to onboard. Send BTC to the boarding address first.");
    }

    // Onboard: convert boarding UTXOs → VTXOs
    const txid = await new Ramps(wallet).onboard(this.serverInfo.fees);

    // Check post-onboard balance
    const postBal = await wallet.getBalance();
    const availableSats = Number((postBal as any).available ?? 0);

    return {
      txid: txid ?? "",
      boardingSats,
      availableSats,
    };
  }

  async getAddress(): Promise<GetAddressResult> {
    const identity = this.getIdentity();
    const pubkey = await identity.xOnlyPublicKey();

    return {
      address: this.address ?? "",
      pubkey: hex.encode(pubkey),
      network: this.config.arkadeNetwork,
    };
  }

  async getVtxos(spendableOnly = true): Promise<GetVtxosResult> {
    const wallet = this.getWallet();

    // Use SDK's Wallet.getVtxos() which queries the correct internal script
    const allVtxos = await wallet.getVtxos({ withRecoverable: !spendableOnly });

    const vtxos = allVtxos.map((v: any) => ({
      txid: v.txid as string,
      vout: v.vout as number,
      valueSats: Number(v.value),
      state: v.virtualStatus?.state ?? "unknown",
    }));

    return { vtxos, count: vtxos.length };
  }

}
