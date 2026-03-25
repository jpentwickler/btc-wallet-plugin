# WALLET-002: Claude Cowork Plugin & Remote Deployment

## User Story

**As an** AI agent operator
**I want** to deploy the BTC wallet plugin as a remote MCP server on Railway and install it as a Claude Cowork plugin
**So that** AI agents on Claude Cowork can manage BTC wallets on Mutinynet — creating wallets, checking balances, locking collateral, and signing escrow releases — without requiring a local Node.js process

## Story Points: 3

## Status: DONE

## Repository

Same repo: `btc-wallet-plugin`

Extends WALLET-001 (which built the MCP server with 9 tools and stdio transport) with HTTP transport, Railway deployment, and Claude Cowork plugin packaging.

---

## Context

### What WALLET-001 Built

WALLET-001 delivered a working MCP server with 9 tools, tested end-to-end on local regtest:

| Capability | Status |
|---|---|
| 9 MCP tools (create_wallet through verify_vtxo) | Done |
| Stdio transport (Claude Code local) | Done |
| Encrypted keyfile persistence (~/.btc-wallet/key.enc) | Done |
| Local regtest Docker infrastructure | Done |
| Acceptance test on regtest (all tools pass) | Done |

### What's Missing for Claude Cowork

Claude Cowork is a cloud-based agent platform. It can't spawn local processes — it needs to connect to the wallet plugin over HTTP. This requires:

1. **HTTP transport** — the MCP server must serve over HTTP, not just stdio
2. **Railway deployment** — the server runs as a Docker container in the cloud
3. **Plugin packaging** — Claude Cowork needs `.claude-plugin/plugin.json`, `.mcp.json` (HTTP), and `SKILL.md`
4. **Mutinynet configuration** — Cowork agents use the public testnet, not local regtest
5. **Key provisioning** — a workflow to generate, fund, and deploy a wallet key

### Why Mutinynet (not regtest)

Local regtest requires Docker containers on the same machine. Claude Cowork agents run in the cloud — they need a publicly reachable Arkade server. Mutinynet (`mutinynet.arkade.sh`) is the public Arkade testnet.

---

## Architecture

### Dual Transport

The MCP server auto-detects the transport based on the `PORT` environment variable:

```
PORT set (Railway) → Express HTTP server on that port
                     └── /     health check (GET)
                     └── /mcp  MCP Streamable HTTP endpoint (POST/GET/DELETE)

PORT not set (local) → StdioServerTransport (stdin/stdout JSON-RPC)
```

Same code, same tools, different wire protocol.

```
┌─────────────────┐     stdio      ┌──────────────────────────┐
│  Claude Code    │───────────────→│                          │
└─────────────────┘                │  btc-wallet MCP server   │
                                   │                          │
┌─────────────────┐     HTTPS      │  src/server.ts           │
│  Claude Cowork  │───────────────→│  (9 tools)               │
└─────────────────┘  /mcp endpoint │                          │
                                   │         │                │
                                   └─────────┼────────────────┘
                                             │ HTTPS
                                             ▼
                                   ┌──────────────────────────┐
                                   │  Arkade Server           │
                                   │  mutinynet.arkade.sh     │
                                   └──────────────────────────┘
```

### Session Management

Each Claude Cowork connection creates a new MCP session via `StreamableHTTPServerTransport`. Sessions are stateful (session ID in headers) and independent — multiple agents can connect simultaneously, each with their own session.

All sessions share the same wallet instance (`ArkadeWallet`), which is initialized once via `WALLET_PRIVATE_KEY`.

---

## Plugin Structure

### Claude Cowork Plugin (cowork-remote)

```
plugins/cowork-remote/
├── .claude-plugin/
│   └── plugin.json              ← Plugin metadata
├── .mcp.json                    ← HTTP transport → Railway URL
└── skills/
    └── btc-wallet/
        └── SKILL.md             ← Agent skill description
```

**plugin.json:**
```json
{
  "name": "btc-wallet",
  "version": "1.0.0",
  "description": "BTC wallet for AI agents — manage Bitcoin, build escrows, sign multi-party releases on Arkade",
  "author": { "name": "btc-wallet-plugin" },
  "keywords": ["bitcoin", "wallet", "arkade", "escrow", "mcp"]
}
```

**.mcp.json:**
```json
{
  "mcpServers": {
    "btc-wallet": {
      "type": "http",
      "url": "https://<your-app>.up.railway.app/mcp"
    }
  }
}
```

---

## Deployment Configuration

### Railway Environment Variables

| Variable | Value | Required |
|---|---|---|
| `PORT` | (auto-set by Railway) | Auto |
| `ARKADE_SERVER` | `https://mutinynet.arkade.sh` | Yes |
| `ARKADE_NETWORK` | `mutinynet` | Yes |
| `ARKADE_EXPLORER` | `https://explorer.mutinynet.arkade.sh` | Yes |
| `WALLET_PRIVATE_KEY` | Hex-encoded private key (from `npm run keygen`) | Yes |

### Dockerfile

Multi-stage build: TypeScript compilation in builder stage, production `node_modules` in runtime stage. Express serves on `PORT` with `/mcp` endpoint.

### railway.toml

```toml
[build]
builder = "dockerfile"
dockerfilePath = "Dockerfile"

[deploy]
healthcheckPath = "/"
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

---

## Key Provisioning Flow

### Dev Scripts

| Script | Purpose |
|---|---|
| `npm run keygen` | Generate keypair, print private key hex + boarding address |
| `npm run keygen -- --network regtest` | Same but for local regtest |
| `npm run fund` | Fund wallet from local regtest faucet |

### Provisioning Steps

```
Operator runs:
  npm run keygen
  → Prints: WALLET_PRIVATE_KEY=<hex>
  → Prints: Boarding address: tb1p...

Operator:
  1. Sets WALLET_PRIVATE_KEY in Railway secrets
  2. Sends Mutinynet tBTC to the boarding address (faucet)
  3. Deploys to Railway

Agent boots:
  1. Server starts on PORT (HTTP transport)
  2. Agent calls create_wallet → restores from WALLET_PRIVATE_KEY
  3. Agent calls onboard → boarding UTXOs → VTXOs
  4. Agent is ready to operate
```

### Future: Automated Provisioning (out of scope)

Website generates key → Railway API sets secrets + deploys → website funds boarding address via faucet API → agent is ready with zero manual steps. See memory: `project_agent_provisioning.md`.

---

## Security

### Private Key Protection

- Private key set as Railway secret (encrypted at rest, not in logs)
- Never returned in MCP tool responses
- Never logged by the server
- `create_wallet` returns `restored: true/false`, not the key

### Network Security

- Railway provides HTTPS termination (TLS)
- MCP Streamable HTTP transport over HTTPS
- Future: add Bearer token auth header for endpoint protection

---

## Acceptance Criteria

### Deployment

- [ ] Server builds and deploys to Railway from Dockerfile
- [ ] Health check `GET /` returns `{"name":"btc-wallet","status":"ok"}`
- [ ] MCP endpoint `POST /mcp` accepts MCP protocol requests
- [ ] `WALLET_PRIVATE_KEY` env var restores the same wallet across restarts

### Plugin

- [ ] `plugins/cowork-remote/` contains `.claude-plugin/plugin.json`, `.mcp.json`, `SKILL.md`
- [ ] Plugin installable in Claude Cowork
- [ ] Agent sees 9 tools after plugin install

### Tools (remote, Mutinynet)

- [ ] `create_wallet` — restores from env var, returns boarding address
- [ ] `get_balance` — returns granular balance (available, settled, preconfirmed, boarding)
- [ ] `get_address` — returns tb1p... address and pubkey
- [ ] `onboard` — converts boarding UTXOs to VTXOs
- [ ] `get_vtxos` — lists wallet's VTXOs with state
- [ ] `build_escrow` — constructs 4-path escrow with tark1q... address
- [ ] `lock_collateral` — locks sats into escrow VTXO
- [ ] `verify_vtxo` — confirms VTXO exists with value
- [ ] `sign_release` — signs Path A PSBT, returns complete=false

### Dev Scripts

- [ ] `npm run keygen` — generates keypair, prints WALLET_PRIVATE_KEY for Railway
- [ ] `npm run fund` — funds wallet from local regtest faucet

---

## Manual Acceptance Test

### Prerequisites

- Railway account
- GitHub repo `btc-wallet-plugin` connected to Railway
- Mutinynet faucet access (`https://faucet.mutinynet.com`)
- Claude Cowork access

### Phase 1: Key Generation & Funding

| Step | Action | Expected |
|---|---|---|
| 1 | Run `npm run keygen` locally | Prints private key hex, public key, and `tb1p...` boarding address for Mutinynet |
| 2 | Copy the `WALLET_PRIVATE_KEY=<hex>` line | Key ready for Railway |
| 3 | Open Mutinynet faucet, paste the `tb1p...` boarding address, send tBTC | Faucet confirms send |

### Phase 2: Railway Deployment

| Step | Action | Expected |
|---|---|---|
| 4 | In Railway dashboard, create new project from GitHub repo | Railway detects Dockerfile |
| 5 | Set environment variables: `ARKADE_SERVER`, `ARKADE_NETWORK`, `ARKADE_EXPLORER`, `WALLET_PRIVATE_KEY` | Variables saved as secrets |
| 6 | Deploy | Build succeeds, container starts |
| 7 | `curl https://<app>.up.railway.app/` | Returns `{"name":"btc-wallet","version":"0.1.0","status":"ok"}` |

### Phase 3: Claude Cowork Plugin Install

| Step | Action | Expected |
|---|---|---|
| 8 | Update `plugins/cowork-remote/.mcp.json` with actual Railway URL | URL points to deployed server |
| 9 | Install `plugins/cowork-remote/` as a plugin in Claude Cowork | Plugin shows as connected |
| 10 | Verify 9 tools are visible in Claude Cowork | `create_wallet`, `get_balance`, `get_address`, `onboard`, `get_vtxos`, `build_escrow`, `lock_collateral`, `sign_release`, `verify_vtxo` |

### Phase 4: Wallet Setup (via Claude Cowork agent)

| Step | Action | Expected |
|---|---|---|
| 11 | Agent calls `create_wallet` | Returns `tb1p...` address, `restored: true`, `network: mutinynet` |
| 12 | Agent calls `get_balance` | Returns `boarding: > 0` (from faucet in step 3) |
| 13 | Agent calls `onboard` | Returns txid, boarding sats converted to available |
| 14 | Agent calls `get_balance` | `available: > 0`, `boarding: 0`, `vtxoCount: >= 1` |
| 15 | Agent calls `get_vtxos` | Returns VTXOs with `state: "settled"` or `"preconfirmed"` |
| 16 | Agent calls `get_address` | Returns consistent address and pubkey |

### Phase 5: Escrow Operations (via Claude Cowork agent)

| Step | Action | Expected |
|---|---|---|
| 17 | Agent calls `build_escrow` with own pubkey as borrower + a test lender pubkey | Returns `escrowScript`, `escrowAddress` (tark1q...), 4 paths described |
| 18 | Agent calls `lock_collateral` with escrow script + amount (e.g., half of available) | Returns `txid`, `escrowAddress`, `explorerUrl` |
| 19 | Agent calls `get_balance` | `available` decreased by locked amount |
| 20 | Agent calls `verify_vtxo` with lock txid | Returns `exists: true`, `valueSats` matches locked amount |
| 21 | Agent calls `sign_release` with path "A", recipient = own pubkey, amount = locked amount | Returns `psbt` (base64), `signedBy`, `path: "A"`, `complete: false` |

### Phase 6: Persistence Verification

| Step | Action | Expected |
|---|---|---|
| 22 | Redeploy the Railway service (trigger restart) | Container restarts |
| 23 | Agent calls `create_wallet` | Returns `restored: true`, same address as step 11 |
| 24 | Agent calls `get_balance` | Balance matches post-lock state from step 19 |

All 24 steps pass → story is accepted.

---

## What This Story Does NOT Do

- **No automated provisioning** — key generation and faucet funding are manual. Automated website → Railway API flow is a future story.
- **No multi-tenant** — one wallet key per deployed instance. Multiple agents share the same wallet.
- **No Bearer token auth** — the MCP endpoint is publicly reachable. Auth is a future enhancement.
- **No OpenClaw plugin** — only Claude Cowork. OpenClaw variant is a future story.
- **No production mainnet** — Mutinynet testnet only. Real BTC requires additional security review.

---

## Definition of Done

### Functional

- [ ] HTTP transport works: MCP tools callable over HTTPS
- [ ] All 9 tools pass acceptance test on Mutinynet via remote HTTP
- [ ] Wallet persists across Railway container restarts via WALLET_PRIVATE_KEY
- [ ] Full escrow lifecycle: create → fund → onboard → lock → verify → sign

### Deployment

- [ ] Dockerfile builds and deploys on Railway
- [ ] Health check passes at `GET /`
- [ ] Environment variables documented and set in Railway

### Plugin

- [ ] `plugins/cowork-remote/` contains complete plugin structure
- [ ] Plugin installable and functional in Claude Cowork
- [ ] SKILL.md accurately describes all 9 tools and setup flow

### Dev Tooling

- [ ] `npm run keygen` generates provisioning-ready keypair
- [ ] `npm run fund` works on local regtest

---

## Reference

- **WALLET-001:** `docs/user stories/WALLET001_btc_wallet_plugin.md` — MCP server implementation, 9 tools, stdio transport
- **Spike findings:** `docs/FINDINGS.md` — Arkade SDK patterns, API deviations
- **Plugin reference:** `KnowledgeGraphFactory/plugins/cowork-remote/` — Claude Cowork plugin format
- **MCP Streamable HTTP:** `@modelcontextprotocol/sdk/server/streamableHttp.js` — transport implementation
- **Mutinynet faucet:** `https://faucet.mutinynet.com`
- **Mutinynet explorer:** `https://explorer.mutinynet.arkade.sh`
- **Railway docs:** `https://docs.railway.com`
