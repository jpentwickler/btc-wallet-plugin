# BTC Wallet Plugin

A portable BTC wallet for AI agents. MCP server + SKILL.md wrapping the Arkade SDK.

Any MCP-compatible agent platform (Claude Code, Claude Cowork, OpenClaw) can load this plugin to give an AI agent the ability to manage Bitcoin: create wallets, check balances, lock collateral in multi-path escrows, and sign escrow releases.

## Quick Start

```bash
npm install
npx tsx src/server.ts
```

## Claude Code Integration

Add to your `.mcp.json`:

```json
{
  "btc-wallet": {
    "type": "stdio",
    "command": "npx",
    "args": ["tsx", "src/server.ts"],
    "env": {
      "ARKADE_SERVER": "https://mutinynet.arkade.sh",
      "ARKADE_NETWORK": "mutinynet"
    }
  }
}
```

## Tools

| Tool | Description |
|---|---|
| `create_wallet` | Create or restore a wallet from a private key |
| `get_balance` | Query BTC balance in satoshis |
| `get_address` | Get wallet's Arkade address and pubkey |
| `get_vtxos` | List unspent virtual transaction outputs |
| `build_escrow` | Construct a 4-path escrow script (A, B1, B2, C) |
| `lock_collateral` | Send BTC into an escrow VTXO |
| `sign_release` | Sign a PSBT to release escrow via a specified path |
| `verify_vtxo` | Verify a VTXO exists on the Arkade network |

## Networks

| Network | Server | Use case |
|---|---|---|
| Mutinynet | `https://mutinynet.arkade.sh` | Remote testnet |
| Regtest | `http://localhost:7070` | Local Docker |

## Documentation

- [WALLET-001 User Story](docs/user%20stories/WALLET001_btc_wallet_plugin.md)
