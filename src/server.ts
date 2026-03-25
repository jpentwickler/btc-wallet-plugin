/**
 * BTC Wallet Plugin — MCP Server Entry Point
 *
 * Exposes 8 tools over MCP (JSON-RPC 2.0) via stdio or HTTP transport.
 * Wraps the Arkade SDK to give any AI agent a BTC wallet.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ArkadeWallet } from "./wallet.js";
import { EscrowManager } from "./escrow.js";
import type { WalletConfig } from "./types.js";

// ─── Configuration from environment ──────────────────────────────────────────

const config: WalletConfig = {
  arkadeServer: process.env.ARKADE_SERVER ?? "https://mutinynet.arkade.sh",
  arkadeNetwork: process.env.ARKADE_NETWORK ?? "mutinynet",
  arkadeExplorer:
    process.env.ARKADE_EXPLORER ?? "https://explorer.mutinynet.arkade.sh",
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
};

// ─── Initialize wallet and escrow ────────────────────────────────────────────

const arkadeWallet = new ArkadeWallet(config);
const escrowManager = new EscrowManager(arkadeWallet);

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "btc-wallet", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ─── tools/list ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "create_wallet",
      description:
        "Create or restore a BTC wallet on the Arkade network. Generates a new ephemeral keypair if no private key is provided.",
      inputSchema: {
        type: "object" as const,
        properties: {
          privateKey: {
            type: "string",
            description:
              "Hex-encoded private key to restore a wallet. If omitted, uses WALLET_PRIVATE_KEY env var or generates a new ephemeral key.",
          },
        },
      },
    },
    {
      name: "get_balance",
      description:
        "Query the wallet's BTC balance in satoshis from the Arkade indexer.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "get_address",
      description:
        "Return the wallet's Arkade address (tark1...) and public key.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "onboard",
      description:
        "Convert on-chain boarding UTXOs into off-chain Arkade VTXOs. Required before locking collateral. Costs a small fee.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "get_vtxos",
      description:
        "List the wallet's VTXOs (virtual transaction outputs) on the Arkade network.",
      inputSchema: {
        type: "object" as const,
        properties: {
          spendableOnly: {
            type: "boolean",
            description: "If true, only return spendable VTXOs (default: true)",
          },
        },
      },
    },
    {
      name: "build_escrow",
      description:
        "Construct a 4-path escrow VtxoScript for a lending protocol. Paths: A (cooperative), B1 (emergency), B2 (CLTV default), C (CSV safety exit).",
      inputSchema: {
        type: "object" as const,
        properties: {
          borrowerPubkey: {
            type: "string",
            description: "Borrower's hex-encoded x-only public key (32 bytes)",
          },
          lenderPubkey: {
            type: "string",
            description: "Lender's hex-encoded x-only public key (32 bytes)",
          },
          serverPubkey: {
            type: "string",
            description:
              "Protocol server's hex-encoded x-only public key (32 bytes). If omitted, uses the connected Arkade server's key.",
          },
          cltvDays: {
            type: "number",
            description: "Path B2 CLTV timelock in days (default: 7)",
          },
          csvDays: {
            type: "number",
            description: "Path C CSV timelock in days (default: 14)",
          },
        },
        required: ["borrowerPubkey", "lenderPubkey"],
      },
    },
    {
      name: "lock_collateral",
      description:
        "Send BTC from the wallet into an escrow VTXO. The escrow script must be built first with build_escrow.",
      inputSchema: {
        type: "object" as const,
        properties: {
          escrowScript: {
            type: "string",
            description: "Hex-encoded escrow VtxoScript (from build_escrow)",
          },
          amountSats: {
            type: "number",
            description: "Amount to lock in satoshis",
          },
        },
        required: ["escrowScript", "amountSats"],
      },
    },
    {
      name: "sign_release",
      description:
        "Sign a PSBT to release BTC from an escrow via a specified path. Supports multi-party signing — pass an existing PSBT to add a second signature.",
      inputSchema: {
        type: "object" as const,
        properties: {
          escrowScript: {
            type: "string",
            description: "Hex-encoded escrow VtxoScript",
          },
          path: {
            type: "string",
            enum: ["A", "B1", "B2", "C"],
            description:
              "Escrow path: A (cooperative), B1 (emergency), B2 (CLTV default), C (CSV safety)",
          },
          recipientAddress: {
            type: "string",
            description:
              "Hex-encoded x-only public key of the recipient (used to derive their Arkade VTXO)",
          },
          amountSats: {
            type: "number",
            description: "Amount in satoshis to send to recipient",
          },
          changeAddress: {
            type: "string",
            description:
              "Hex-encoded x-only public key for surplus output (fair split second output)",
          },
          changeSats: {
            type: "number",
            description: "Surplus amount in satoshis for change output",
          },
          psbt: {
            type: "string",
            description:
              "Existing base64-encoded PSBT to add signature to (for multi-party signing)",
          },
        },
        required: ["escrowScript", "path", "recipientAddress", "amountSats"],
      },
    },
    {
      name: "verify_vtxo",
      description:
        "Check if a specific VTXO exists on the Arkade network. Returns existence status and explorer link.",
      inputSchema: {
        type: "object" as const,
        properties: {
          txid: {
            type: "string",
            description: "Transaction ID to verify",
          },
          vout: {
            type: "number",
            description: "Output index (default: 0)",
          },
          minSats: {
            type: "number",
            description:
              "Minimum expected satoshis (optional verification check)",
          },
        },
        required: ["txid"],
      },
    },
  ],
}));

// ─── tools/call ──────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "create_wallet": {
        // Ensure server connection is established
        await arkadeWallet.init();
        const result = await arkadeWallet.createWallet(args?.privateKey as string | undefined);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_balance": {
        const result = await arkadeWallet.getBalance();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_address": {
        const result = await arkadeWallet.getAddress();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "onboard": {
        const result = await arkadeWallet.onboard();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_vtxos": {
        const result = await arkadeWallet.getVtxos(args?.spendableOnly as boolean | undefined);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "build_escrow": {
        const result = await escrowManager.buildEscrow({
          borrowerPubkey: args?.borrowerPubkey as string,
          lenderPubkey: args?.lenderPubkey as string,
          serverPubkey: args?.serverPubkey as string,
          cltvDays: args?.cltvDays as number | undefined,
          csvDays: args?.csvDays as number | undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "lock_collateral": {
        const result = await escrowManager.lockCollateral({
          escrowScript: args?.escrowScript as string,
          amountSats: args?.amountSats as number,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "sign_release": {
        const result = await escrowManager.signRelease({
          escrowScript: args?.escrowScript as string,
          path: args?.path as "A" | "B1" | "B2" | "C",
          recipientAddress: args?.recipientAddress as string,
          amountSats: args?.amountSats as number,
          changeAddress: args?.changeAddress as string | undefined,
          changeSats: args?.changeSats as number | undefined,
          psbt: args?.psbt as string | undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "verify_vtxo": {
        const result = await escrowManager.verifyVtxo({
          txid: args?.txid as string,
          vout: args?.vout as number | undefined,
          minSats: args?.minSats as number | undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`btc-wallet MCP server running (${config.arkadeNetwork} @ ${config.arkadeServer})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
