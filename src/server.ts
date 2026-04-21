/**
 * BTC Wallet Plugin — MCP Server Entry Point
 *
 * Exposes 8 tools over MCP (JSON-RPC 2.0) via stdio or HTTP transport.
 * Wraps the Arkade SDK to give any AI agent a BTC wallet.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";

import { ArkadeWallet } from "./wallet.js";
import { EscrowManager } from "./escrow.js";
import type { WalletConfig } from "./types.js";

// ─── Configuration from environment ──────────────────────────────────────────

const config: WalletConfig = {
  arkadeServer: process.env.ARKADE_SERVER ?? "https://mutinynet.arkade.sh",
  arkadeNetwork: process.env.ARKADE_NETWORK ?? "mutinynet",
  arkadeExplorer:
    process.env.ARKADE_EXPLORER ?? "https://explorer.mutinynet.arkade.sh",
  esploraUrl: process.env.ESPLORA_URL,
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
};

// ─── Initialize wallet and escrow ────────────────────────────────────────────

const arkadeWallet = new ArkadeWallet(config);
const escrowManager = new EscrowManager(arkadeWallet);

// ─── MCP Tool Handlers ───────────────────────────────────────────────────────

const handleListTools = async () => ({
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
        "Construct a 4-path escrow VtxoScript for a lending protocol. All paths are plain MultisigTapscript (no on-chain timelocks); timing enforcement is server-gated by the Protocol Service. Paths: A (cooperative 3-of-3), B1 (LTV liquidation 2-of-2), B2 (default backstop 2-of-2), C (borrower safety exit 2-of-2).",
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
            description: "DEPRECATED: ignored. Retained for backward compatibility with callers. All time enforcement is server-gated (ADR-004).",
          },
          csvDays: {
            type: "number",
            description: "DEPRECATED: ignored. Retained for backward compatibility with callers. All time enforcement is server-gated (ADR-004).",
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
      name: "sign_checkpoints",
      description:
        "Sign Arkade checkpoint PSBTs for escrow release finalization. Called after the Protocol Service returns checkpoint PSBTs from the Arkade server.",
      inputSchema: {
        type: "object" as const,
        properties: {
          checkpointPsbts: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of base64-encoded checkpoint PSBTs to sign",
          },
        },
        required: ["checkpointPsbts"],
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
});

const handleCallTool = async (request: any) => {
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

      case "sign_checkpoints": {
        const result = await escrowManager.signCheckpoints({
          checkpointPsbts: args?.checkpointPsbts as string[],
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
};

/** Register tool handlers on a Server instance. */
function registerHandlers(s: Server) {
  s.setRequestHandler(ListToolsRequestSchema, handleListTools);
  s.setRequestHandler(CallToolRequestSchema, handleCallTool);
}

// Register on the main server (used by stdio transport)
const server = new Server(
  { name: "btc-wallet", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
registerHandlers(server);

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const port = process.env.PORT;

  if (port) {
    // ── HTTP transport (deployed — Railway, Claude Cowork) ──
    const app = express();
    app.use(express.json());

    // Health check
    app.get("/", (_req, res) => {
      res.json({ name: "btc-wallet", version: "0.1.0", status: "ok" });
    });

    // MCP endpoint — one transport per session
    const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

    app.all("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "GET" || (req.method === "DELETE" && sessionId)) {
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (session) {
          await session.transport.handleRequest(req, res);
        } else {
          res.status(400).json({ error: "No session" });
        }
        return;
      }

      // POST — new or existing session
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
        return;
      }

      // New session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { server: sessionServer, transport });
        },
      });

      const sessionServer = new Server(
        { name: "btc-wallet", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );
      registerHandlers(sessionServer);

      await sessionServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    app.listen(Number(port), "0.0.0.0", () => {
      console.error(`btc-wallet MCP server (HTTP) on port ${port} (${config.arkadeNetwork} @ ${config.arkadeServer})`);
    });
  } else {
    // ── Stdio transport (local — Claude Code) ──
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`btc-wallet MCP server running (${config.arkadeNetwork} @ ${config.arkadeServer})`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
