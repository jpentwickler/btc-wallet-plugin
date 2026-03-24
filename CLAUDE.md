# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project

Portable BTC wallet plugin for AI agents. An MCP server (TypeScript/Node.js) wrapping the Arkade SDK that gives any AI agent the ability to manage Bitcoin — create wallets, check balances, lock collateral in multi-path escrows, and sign escrow releases.

Platform-agnostic: works with Claude Code, Claude Cowork, and OpenClaw.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js v22+ |
| Language | TypeScript |
| BTC operations | Arkade SDK (`@arkade-os/sdk`) |
| MCP server | `@modelcontextprotocol/sdk` |
| Dev execution | `tsx` |

## Architecture

The plugin is a standalone MCP server that exposes 8 tools:

```
AI Agent ──MCP──→ BTC Wallet Plugin ──Arkade SDK──→ Arkade Network (Mutinynet/regtest)
```

The plugin holds the agent's wallet key and signs transactions. It does NOT hold the protocol server key — that belongs to the lending Protocol Service (separate repo).

## MCP Tools (8)

| Tool | Purpose |
|---|---|
| `create_wallet` | Create or restore wallet from private key |
| `get_balance` | Query sats balance from Arkade indexer |
| `get_address` | Return wallet's tark1... address and pubkey |
| `get_vtxos` | List wallet's VTXOs |
| `build_escrow` | Construct 4-path escrow VtxoScript |
| `lock_collateral` | Send BTC into escrow VTXO |
| `sign_release` | Sign PSBT for escrow path (A, B1, B2, C) |
| `verify_vtxo` | Check if VTXO exists on Arkade |

## Escrow Paths

| Path | Signers | When used |
|---|---|---|
| A | Borrower + Lender + Server | Cooperative release (repayment) |
| B1 | Lender + Server | Emergency liquidation |
| B2 | Lender + Server (after CLTV) | Default backstop (7-day timelock) |
| C | Borrower + Server (after CSV) | Borrower safety exit (14-day timelock) |

## Networks

| Network | Server URL | Config |
|---|---|---|
| Mutinynet (testnet) | `https://mutinynet.arkade.sh` | `ARKADE_NETWORK=mutinynet` |
| Local regtest | `http://localhost:7070` | `ARKADE_NETWORK=regtest` |

Explorer: `https://explorer.mutinynet.arkade.sh`

## Environment Variables

| Variable | Default | Required |
|---|---|---|
| `ARKADE_SERVER` | `https://mutinynet.arkade.sh` | No |
| `ARKADE_NETWORK` | `mutinynet` | No |
| `ARKADE_EXPLORER` | `https://explorer.mutinynet.arkade.sh` | No |
| `WALLET_PRIVATE_KEY` | (auto-generate) | No |

## Related Repositories

- **LoanMarketPlace** (`jpentwickler/LoanMarketPlace`) — BTC-collateralized lending protocol. This wallet plugin is one of two agent capabilities needed to participate in the protocol.
- **Spike code** — `LoanMarketPlace/spikes/escrow-test.ts` and `spike002-release-test.ts` contain validated Arkade SDK patterns to reuse.

## Key Principles

- **Non-custodial** — the plugin holds keys for the agent's own wallet only. Cannot move funds from other wallets.
- **Private keys never exposed** — never in MCP responses, never logged.
- **Platform-agnostic** — any MCP-compatible host can load this plugin.
- **Protocol-agnostic** — the wallet doesn't know about lending, LTV, or interest. It's a general BTC capability. The agent composes wallet tools with protocol tools.
