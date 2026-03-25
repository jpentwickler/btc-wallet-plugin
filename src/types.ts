/**
 * TypeScript types for all 8 MCP tool parameters and responses.
 */

// ─── Configuration ───────────────────────────────────────────────────────────

export interface WalletConfig {
  arkadeServer: string;
  arkadeNetwork: string;
  arkadeExplorer: string;
  walletPrivateKey?: string;
}

// ─── Tool Parameters ─────────────────────────────────────────────────────────

export interface CreateWalletParams {
  privateKey?: string;
}

// get_balance, get_address, onboard: no params

export interface GetVtxosParams {
  spendableOnly?: boolean;
}

export interface BuildEscrowParams {
  borrowerPubkey: string;
  lenderPubkey: string;
  serverPubkey: string;
  cltvDays?: number;
  csvDays?: number;
}

export interface LockCollateralParams {
  escrowScript: string;
  amountSats: number;
}

export interface SignReleaseParams {
  escrowScript: string;
  path: "A" | "B1" | "B2" | "C";
  recipientAddress: string;
  amountSats: number;
  changeAddress?: string;
  changeSats?: number;
  psbt?: string;
}

export interface VerifyVtxoParams {
  txid: string;
  vout?: number;
  minSats?: number;
}

// ─── Tool Responses ──────────────────────────────────────────────────────────

export interface CreateWalletResult {
  address: string;
  pubkey: string;
  network: string;
  restored: boolean;
}

export interface GetBalanceResult {
  available: number;
  settled: number;
  preconfirmed: number;
  boarding: number;
  total: number;
  address: string;
  vtxoCount: number;
}

export interface GetAddressResult {
  address: string;
  pubkey: string;
  network: string;
}

export interface OnboardResult {
  txid: string;
  boardingSats: number;
  availableSats: number;
}

export interface VtxoInfo {
  txid: string;
  vout: number;
  valueSats: number;
  state: string;
}

export interface GetVtxosResult {
  vtxos: VtxoInfo[];
  count: number;
}

export interface BuildEscrowResult {
  escrowScript: string;
  escrowAddress: string;
  paths: {
    A: string;
    B1: string;
    B2: string;
    C: string;
  };
}

export interface LockCollateralResult {
  txid: string;
  amountSats: number;
  escrowAddress: string;
  explorerUrl: string;
}

export interface SignReleaseResult {
  psbt: string;
  signedBy: string;
  path: string;
  complete: boolean;
}

export interface VerifyVtxoResult {
  exists: boolean;
  valueSats: number;
  script: string;
  explorerUrl: string;
}
