# WALLET-001: BTC Wallet Plugin — Arkade MCP Server for AI Agents

## User Story

**As an** AI agent developer
**I want** a portable BTC wallet plugin (MCP server + SKILL.md) that wraps the Arkade SDK to create wallets, check balances, lock collateral in multi-path escrows, and sign escrow releases
**So that** any AI agent on Claude Code, Claude Cowork, or OpenClaw can autonomously manage BTC — participating in lending protocols, securing collateral, and executing escrow operations on Mutinynet or local regtest

## Story Points: 5

## Status: TODO

## Repository

**New standalone repo:** `btc-wallet-plugin`

Separate from `LoanMarketPlace`. Independent deployment, versioning, and release cycle. The LoanMarketPlace project references it as an external MCP server in `.mcp.json`. Any MCP-compatible agent platform can use this plugin — it is not tied to the lending protocol.

## Context

### What the Spikes Proved

SPIKE-001 and SPIKE-002 in the `LoanMarketPlace` repo validated the hard parts:

| Validated | SPIKE | Key finding |
|---|---|---|
| Arkade server connection | SPIKE-001 | Mutinynet at `https://mutinynet.arkade.sh`, local regtest via Docker |
| Wallet creation | SPIKE-001 | `SingleKey` identity, `tark1...` addresses |
| 4-path escrow construction | SPIKE-001 | Path A (MultisigTapscript), Path B (CLTVMultisigTapscript), Path C (CSVMultisigTapscript) |
| Collateral locking | SPIKE-001 | BTC moves into escrow VTXO successfully |
| Path A collaborative release | SPIKE-002 | Full PSBT signing flow: borrower → lender → server co-sign → checkpoint → finalize |
| Balance verification | SPIKE-002 | Query balance after release confirms funds returned |

The code patterns from `spikes/escrow-test.ts` and `spikes/spike002-release-test.ts` are the foundation for this plugin.

### What This Plugin Does

A standalone MCP server (Node.js/TypeScript) that gives any AI agent a BTC wallet on Arkade:

```
┌─────────────────────────────────────┐
│  BTC Wallet Plugin (MCP Server)     │
│                                     │
│  MCP Tools:                         │
│    create_wallet                    │
│    get_balance                      │
│    get_address                      │
│    get_vtxos                        │
│    build_escrow                     │
│    lock_collateral                  │
│    sign_release                     │
│    verify_vtxo                      │
│                                     │
│  SKILL.md:                          │
│    Teaches the agent when and       │
│    how to use the wallet tools      │
│                                     │
│  Arkade SDK (@arkade-os/sdk)        │
└─────────────────────────────────────┘
        │           │           │
   Claude Code  Claude Cowork  OpenClaw
```

### What This Plugin Does NOT Do

- **No lending protocol logic** — the plugin doesn't know about loans, LTV, or interest rates. It's a wallet.
- **No USDT/Polygon operations** — that's a separate plugin (WALLET-002).
- **No escrow co-signing** — the server signing key belongs to the Protocol Service (BACK-007), not the wallet plugin.
- **No custody** — the plugin holds keys for the agent's own wallet. It cannot move funds from other wallets.

### How It Integrates with the Lending Protocol

The agent loads two plugins and combines them:

```
Agent loads:
  Plugin 1: btc-lending-protocol (16 protocol tools)
  Plugin 2: btc-wallet (8 wallet tools)

Agent reasons:
  "I need to lock collateral for this loan."
  Step 1: btc-wallet → get_balance → 1,000,000 sats
  Step 2: btc-lending-protocol → create_loan → loan created
  Step 3: btc-wallet → build_escrow → escrow script ready
  Step 4: btc-wallet → lock_collateral → BTC locked, txid returned
  Step 5: btc-lending-protocol → update_loan_status → collateral_locked
```

The wallet doesn't know about the protocol. The protocol doesn't know about the wallet. The agent composes them.

---

## Plugin Architecture

### MCP Server

Node.js/TypeScript process that speaks MCP protocol (JSON-RPC 2.0) over stdio or HTTP.

**stdio (local):** Claude Code or OpenClaw spawns it as a subprocess:
```json
{
  "btc-wallet": {
    "type": "stdio",
    "command": "npx",
    "args": ["tsx", "src/server.ts"],
    "env": {
      "ARKADE_SERVER": "https://mutinynet.arkade.sh",
      "WALLET_PRIVATE_KEY": "hex-encoded-private-key"
    }
  }
}
```

**HTTP (Railway):** Deployed as a Docker container, agents connect remotely:
```json
{
  "btc-wallet": {
    "type": "http",
    "url": "https://btc-wallet-production.up.railway.app/mcp"
  }
}
```

### SKILL.md

A markdown file that teaches the agent what the wallet can do and when to use each tool:

```markdown
You have a BTC wallet on the Arkade network. Use it to manage Bitcoin
for collateral operations in lending protocols.

When you need to check your BTC balance, use `get_balance`.
When you need to lock BTC as collateral, first `build_escrow` with
the counterparty's pubkey and server pubkey, then `lock_collateral`.
When you need to release collateral, use `sign_release` with the
appropriate escrow path (A for cooperative, B1 for liquidation, C for safety exit).
```

The SKILL.md is loaded by the agent platform alongside the MCP tools. The agent reads it to understand the wallet's capabilities.

---

## MCP Tools

### Tool 1: `create_wallet`

Create or restore a wallet from a private key.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `privateKey` | string | No | Hex-encoded private key. If not provided, generates a new one (ephemeral). |

**Returns:**
```json
{
  "address": "tark1...",
  "pubkey": "02abc...",
  "network": "mutinynet",
  "created": true
}
```

**Behavior:**
- If `WALLET_PRIVATE_KEY` env var is set and no `privateKey` param given, uses env var
- If neither env var nor param, generates a new ephemeral keypair
- Stores the identity in memory for use by other tools
- Never returns the private key in the response

### Tool 2: `get_balance`

Query the wallet's BTC balance from the Arkade indexer.

**Parameters:** None (uses the created wallet)

**Returns:**
```json
{
  "balanceSats": 1000000,
  "address": "tark1...",
  "vtxoCount": 3
}
```

### Tool 3: `get_address`

Return the wallet's Arkade address.

**Parameters:** None

**Returns:**
```json
{
  "address": "tark1...",
  "pubkey": "02abc...",
  "network": "mutinynet"
}
```

### Tool 4: `get_vtxos`

List the wallet's VTXOs (virtual transaction outputs).

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `spendableOnly` | boolean | No | If true, only return spendable VTXOs (default: true) |

**Returns:**
```json
{
  "vtxos": [
    {
      "txid": "abc123...",
      "vout": 0,
      "valueSats": 500000,
      "script": "hex..."
    }
  ],
  "count": 1
}
```

### Tool 5: `build_escrow`

Construct a 4-path escrow VtxoScript for a lending protocol.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `borrowerPubkey` | string | Yes | Borrower's hex-encoded public key |
| `lenderPubkey` | string | Yes | Lender's hex-encoded public key |
| `serverPubkey` | string | Yes | Protocol server's hex-encoded public key |
| `cltvDays` | int | No | Path B CLTV timelock in days (default: 7) |
| `csvDays` | int | No | Path C CSV timelock in days (default: 14) |

**Returns:**
```json
{
  "escrowScript": "hex-encoded-vtxo-script",
  "escrowAddress": "tark1escrow...",
  "paths": {
    "A": "borrower + lender + server (anytime)",
    "B1": "lender + server (emergency, anytime)",
    "B2": "lender + server (after CLTV)",
    "C": "borrower + server (after CSV)"
  }
}
```

**Behavior:**
- Constructs a `VtxoScript` with 4 Tapscript paths per the MVP spec
- Path A: `MultisigTapscript` (all three signers)
- Path B1: `MultisigTapscript` (lender + server only, for emergency liquidation)
- Path B2: `CLTVMultisigTapscript` (lender + server, absolute timelock)
- Path C: `CSVMultisigTapscript` (borrower + server, relative timelock)
- Returns the escrow script for use in `lock_collateral`

### Tool 6: `lock_collateral`

Send BTC from the wallet into an escrow VTXO.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `escrowScript` | string | Yes | Hex-encoded escrow VtxoScript (from `build_escrow`) |
| `amountSats` | int | Yes | Amount to lock in satoshis |

**Returns:**
```json
{
  "txid": "abc123...",
  "amountSats": 470000,
  "escrowAddress": "tark1escrow...",
  "explorerUrl": "https://explorer.mutinynet.arkade.sh/tx/abc123..."
}
```

### Tool 7: `sign_release`

Sign a PSBT to release BTC from an escrow via a specified path.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `escrowScript` | string | Yes | Hex-encoded escrow VtxoScript |
| `path` | string | Yes | Escrow path: "A", "B1", "B2", or "C" |
| `recipientAddress` | string | Yes | Arkade address to receive the BTC |
| `amountSats` | int | Yes | Amount to send to recipient |
| `changeAddress` | string | No | Address for surplus (fair split second output) |
| `changeSats` | int | No | Surplus amount in sats |
| `psbt` | string | No | Existing partially-signed PSBT to add signature to (for multi-party signing) |

**Returns:**
```json
{
  "psbt": "base64-encoded-partially-signed-transaction",
  "signedBy": "borrower",
  "path": "A",
  "complete": false
}
```

**Behavior:**
- If no `psbt` provided: builds a new transaction and signs it (first signer)
- If `psbt` provided: adds this wallet's signature (second signer in multi-party flow)
- Returns the PSBT for the next signer (or for server submission)
- `complete: true` only when all required signatures for the path are present (excluding server)

### Tool 8: `verify_vtxo`

Check if a specific VTXO exists and is funded on the Arkade network.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `txid` | string | Yes | Transaction ID to verify |
| `minSats` | int | No | Minimum expected sats (verification check) |

**Returns:**
```json
{
  "exists": true,
  "valueSats": 470000,
  "script": "hex...",
  "explorerUrl": "https://explorer.mutinynet.arkade.sh/tx/abc123..."
}
```

---

## SKILL.md Content

```markdown
---
name: btc-wallet
description: Manage a BTC wallet on the Arkade network. Lock and release
  collateral in multi-path escrows for lending protocols.
---

# BTC Wallet Skill

You have a BTC wallet on the Arkade network (Bitcoin layer 2 using VTXOs).
Your wallet holds satoshis and can participate in multi-path escrow contracts.

## Your Capabilities

- **Check balance**: Use `get_balance` to see how many sats you have available.
- **Get your address**: Use `get_address` to share your tark1... address with others.
- **View your VTXOs**: Use `get_vtxos` to see your unspent virtual transaction outputs.
- **Build escrow**: Use `build_escrow` when setting up a collateralized loan. You need
  the counterparty's pubkey and the protocol server's pubkey.
- **Lock collateral**: Use `lock_collateral` to send BTC into an escrow VTXO.
  Only do this AFTER the lender has committed (the protocol ensures this ordering).
- **Sign release**: Use `sign_release` to sign your part of an escrow release.
  The path depends on the situation:
  - Path A: cooperative release (you + counterparty + server all agree)
  - Path B1: emergency liquidation (lender + server, borrower not needed)
  - Path C: safety exit (borrower + server, lender not needed)
- **Verify VTXO**: Use `verify_vtxo` to confirm a transaction exists on-chain.

## Important Rules

- NEVER share your private key.
- NEVER lock collateral before the lender has committed to the loan.
- ALWAYS verify the escrow VTXO exists after locking (`verify_vtxo`).
- ALWAYS check your balance before locking to ensure you have enough sats.
- When signing a release, you will receive a PSBT. The other party must also sign.
  You cannot release escrow funds unilaterally (except Path C after the CSV timelock expires).
```

---

## Key Management

| Mode | How it works | Use case |
|---|---|---|
| **Environment variable** | `WALLET_PRIVATE_KEY` in `.mcp.json` env block or Railway dashboard | Persistent testnet wallet |
| **Auto-generate** | No key provided → plugin generates ephemeral keypair | Quick testing, throwaway |
| **Parameter** | Pass `privateKey` to `create_wallet` tool | Agent manages its own keys |

For testnet (Mutinynet): environment variable is sufficient. The key is a hex string.

For production: a future enhancement would integrate with secure key storage (OS keychain, KMS). Out of scope for this story.

**Security rules:**
- Private keys are NEVER returned in MCP tool responses
- Private keys are NEVER logged
- The wallet identity is held in memory for the process lifetime only

---

## Network Configuration

Configurable via environment variables:

| Variable | Default | Description |
|---|---|---|
| `ARKADE_SERVER` | `https://mutinynet.arkade.sh` | Arkade server URL |
| `ARKADE_NETWORK` | `mutinynet` | Network name (`mutinynet` or `regtest`) |
| `ARKADE_EXPLORER` | `https://explorer.mutinynet.arkade.sh` | Block explorer URL for links |
| `WALLET_PRIVATE_KEY` | (none) | Hex-encoded private key (optional) |

**Local regtest:** Set `ARKADE_SERVER=http://localhost:7070` and `ARKADE_NETWORK=regtest`. Requires Docker environment from `LoanMarketPlace/infra/start.sh`.

---

## Acceptance Criteria

### Tools

- [ ] `create_wallet` — creates wallet from env var, from param, or auto-generates
- [ ] `get_balance` — returns balance in sats from Arkade indexer
- [ ] `get_address` — returns tark1... address and pubkey
- [ ] `get_vtxos` — lists spendable VTXOs
- [ ] `build_escrow` — constructs 4-path VtxoScript with configurable timelocks
- [ ] `lock_collateral` — sends BTC into escrow VTXO, returns txid
- [ ] `sign_release` — signs PSBT for specified path, supports multi-party signing
- [ ] `verify_vtxo` — confirms VTXO exists on Arkade

### Network

- [ ] All tools work on Mutinynet (remote testnet)
- [ ] All tools work on local regtest (Docker)
- [ ] Network configurable via environment variables
- [ ] Explorer links included in responses for on-chain verification

### Plugin Integration

- [ ] Claude Code: plugin loads via `.mcp.json` (stdio), `/mcp` shows 8 tools
- [ ] Claude Cowork: plugin loads via shared Railway HTTP endpoint
- [ ] OpenClaw: plugin configurable in `openclaw.json` MCP adapter
- [ ] SKILL.md loadable by all three platforms

### Security

- [ ] Private key never in MCP responses
- [ ] Private key never logged
- [ ] Auto-generated keys are ephemeral (in-memory only)

---

## Definition of Done

### Functional

- [ ] Full escrow lifecycle on Mutinynet: create wallet → fund from faucet → build escrow → lock collateral → sign Path A release → verify balance returned
- [ ] Full escrow lifecycle on local regtest (same steps)
- [ ] Multi-party signing works: borrower signs → lender signs same PSBT → ready for server
- [ ] Two-output transaction works: fair split with recipient + change address (for liquidation)
- [ ] All 8 MCP tools return correct responses

### Deployment

- [ ] Local stdio works (Claude Code spawns Node.js process)
- [ ] Railway HTTP works (Docker container, MCP HTTP transport)
- [ ] Dockerfile builds and runs
- [ ] Environment variables documented

### Integration

- [ ] Claude Code: manual test — create wallet, check balance, lock and release escrow
- [ ] SKILL.md describes all capabilities accurately
- [ ] Plugin works alongside `btc-lending-protocol` MCP server (two plugins, one agent)

---

## Output

### Project Structure

```
btc-wallet-plugin/
├── src/
│   ├── server.ts              — MCP server entry point (tools/list, tools/call)
│   ├── wallet.ts              — Arkade wallet wrapper (create, balance, VTXOs)
│   ├── escrow.ts              — 4-path escrow construction and signing
│   └── types.ts               — TypeScript types for tools and responses
├── skill/
│   └── SKILL.md               — Agent skill description
├── docs/
│   └── user stories/
│       └── WALLET001_btc_wallet_plugin.md  — this file
├── package.json               — Dependencies: @arkade-os/sdk, mcp-typescript-sdk
├── tsconfig.json              — TypeScript config
├── Dockerfile                 — Node.js 22 slim, MCP HTTP transport
├── railway.toml               — Railway build/deploy config
├── .dockerignore              — Exclude dev files
├── .env.example               — Example environment variables
└── README.md                  — Setup, usage, deployment guide
```

### Dependencies

| Package | Purpose |
|---|---|
| `@arkade-os/sdk` | Arkade wallet, VTXO, escrow, PSBT operations |
| `@modelcontextprotocol/sdk` | MCP server implementation (TypeScript) |
| `tsx` | TypeScript execution for local development |

---

## Technical Notes

### Reuse from Spikes

Code patterns to lift from `LoanMarketPlace/spikes/`:

| Spike file | What to reuse |
|---|---|
| `escrow-test.ts` | Wallet creation (`SingleKey`), server connection, 4-path `VtxoScript` construction, VTXO boarding, collateral locking |
| `spike002-release-test.ts` | VTXO query (`getVtxos`), `buildOffchainTx`, PSBT signing flow (borrower → lender), `submitTx`, checkpoint signing, `finalizeTx` |
| `FINDINGS.md` | Server URLs, SDK version compatibility notes, working code patterns |

### Multi-Party Signing Flow

The escrow release requires sequential signing:

```
1. First signer (borrower or lender) calls sign_release → gets PSBT
2. Second signer calls sign_release with the PSBT → adds their signature
3. Agent submits the double-signed PSBT to the Protocol Service co-sign endpoint (BACK-007)
4. Server validates conditions, adds third signature, finalizes
```

The plugin handles steps 1-2. Step 3-4 is the Protocol Service's responsibility (BACK-007).

### Two-Output Transactions (Fair Split)

For liquidation, the release transaction has two outputs:

```
Escrow VTXO (470,000 sats)
    ├── Output 1: 437,819 sats → lender address (debt equivalent)
    └── Output 2:  32,181 sats → borrower address (surplus)
```

The `sign_release` tool supports this via `recipientAddress` + `amountSats` for output 1 and `changeAddress` + `changeSats` for output 2.

### MCP Server Implementation

Use the official `@modelcontextprotocol/sdk` TypeScript library:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";

const server = new Server({ name: "btc-wallet", version: "0.1.0" }, {
  capabilities: { tools: {} }
});

server.setRequestHandler("tools/list", async () => ({
  tools: [
    { name: "create_wallet", description: "...", inputSchema: {...} },
    // ... all 8 tools
  ]
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;
  switch (name) {
    case "create_wallet": return handleCreateWallet(args);
    // ...
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## Manual Acceptance Test — Claude Code

### Setup

1. Clone `btc-wallet-plugin` repo
2. `npm install`
3. Add to Claude Code `.mcp.json`:
   ```json
   {
     "btc-wallet": {
       "type": "stdio",
       "command": "npx",
       "args": ["tsx", "C:\\path\\to\\btc-wallet-plugin\\src\\server.ts"],
       "env": {
         "ARKADE_SERVER": "https://mutinynet.arkade.sh",
         "ARKADE_NETWORK": "mutinynet"
       }
     }
   }
   ```
4. Restart Claude Code

### Phase 1: Wallet Creation

| Step | Action | Expected |
|---|---|---|
| 1 | Run `/mcp` | `btc-wallet` server shows connected, 8 tools listed |
| 2 | Call `create_wallet` (no params) | Returns `address: tark1...`, `pubkey: 02...`, `created: true` |
| 3 | Call `get_address` | Returns same address as step 2 |
| 4 | Call `get_balance` | Returns `balanceSats: 0` (new wallet, no funds) |

### Phase 2: Funding (Manual Step)

| Step | Action | Expected |
|---|---|---|
| 5 | Copy the `tark1...` address from step 2 | Address copied |
| 6 | Open Mutinynet faucet (`faucet.mutinynet.com`), paste address, request tBTC | Faucet confirms send |
| 7 | Wait ~30 seconds for confirmation | |
| 8 | Call `get_balance` | Returns `balanceSats: > 0` (funded!) |
| 9 | Call `get_vtxos` | Returns at least 1 VTXO |

### Phase 3: Escrow Construction

| Step | Action | Expected |
|---|---|---|
| 10 | Call `build_escrow` with borrower pubkey (from step 2), a test lender pubkey, and a test server pubkey | Returns `escrowScript`, `escrowAddress`, 4 paths described |
| 11 | Call `lock_collateral` with escrow script and amount (e.g., 100000 sats) | Returns `txid`, `explorerUrl` |
| 12 | Call `verify_vtxo` with the txid | Returns `exists: true`, `valueSats: 100000` |
| 13 | Call `get_balance` | Balance decreased by ~100000 sats |

### Phase 4: Escrow Release (Path A)

| Step | Action | Expected |
|---|---|---|
| 14 | Call `sign_release` with path "A", recipient = wallet address, amount = 100000 | Returns `psbt` (partially signed), `complete: false` |
| 15 | Verify PSBT is valid base64 | Parseable string |

Note: completing the release requires the lender's signature + server co-sign (BACK-007). The plugin's job is to produce a valid partial signature. Full end-to-end release tested in integration with BACK-007.

### Phase 5: Two-Output Transaction (Fair Split)

| Step | Action | Expected |
|---|---|---|
| 16 | Call `sign_release` with path "B1", recipient = lender address, amount = 70000, changeAddress = borrower address, changeSats = 30000 | Returns `psbt` with two outputs |

All 16 steps pass → story is accepted.

---

## What This Story is NOT

- **No lending protocol integration** — the plugin is a general BTC wallet, not lending-specific. Integration is BACK-007 + AGENT-001/002.
- **No USDT/Polygon** — that's WALLET-002 (separate plugin).
- **No server co-signing** — the server signing key belongs to the Protocol Service (BACK-007). This plugin signs with the agent's key only.
- **No production key management** — hardware wallets, KMS, multi-sig governance are future stories.
- **No Path B2 testing** — requires waiting for CLTV timelock. Tested in integration, not in isolation.
- **No automated tests** — manual acceptance test via Claude Code. Automated tests are a future story.

---

## Reference

- **SPIKE-001:** `LoanMarketPlace/docs/user stories/SPIKE001_arkade_escrow_validation.md` — escrow construction and locking
- **SPIKE-002:** `LoanMarketPlace/docs/user stories/SPIKE002_escrow_release_validation.md` — Path A collaborative release
- **Spike findings:** `LoanMarketPlace/spikes/FINDINGS.md` — server URLs, SDK patterns, deviations
- **Spike code:** `LoanMarketPlace/spikes/escrow-test.ts`, `LoanMarketPlace/spikes/spike002-release-test.ts`
- **Arkade SDK:** `https://arkade-os.github.io/ts-sdk/`
- **Arkade escrow docs:** `https://docs.arkadeos.com/contracts/escrow`
- **MCP TypeScript SDK:** `https://github.com/modelcontextprotocol/typescript-sdk`
- **Mutinynet explorer:** `https://explorer.mutinynet.arkade.sh`
- **Mutinynet faucet:** `https://faucet.mutinynet.com`
