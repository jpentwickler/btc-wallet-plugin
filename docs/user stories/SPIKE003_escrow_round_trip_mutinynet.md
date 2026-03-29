# SPIKE-003: Escrow Round-Trip on Mutinynet — Lock, Release, Verify Return

## User Story

**As a** protocol developer
**I want** to validate that BTC locked in a 4-path escrow can be collaboratively released (Path A) and returned to the borrower's wallet on Mutinynet
**So that** we have confidence the full collateral lifecycle works on the production testnet before wiring up autonomous agents

## Story Points: 2

## Status: DONE

## Context

### What We've Proven

| Capability | Spike | Network | Status |
|---|---|---|---|
| Server connection, wallet creation | SPIKE-001 | regtest | Proven |
| 4-path escrow construction | SPIKE-001 | regtest | Proven |
| Collateral locking | SPIKE-001 | regtest | Proven |
| Single-party signing | manual test | Mutinynet | Proven (one signer only) |
| Full Path A release (lock → sign → finalize → return) | SPIKE-002 | regtest | **Code written, never fully executed** |

### What Has NOT Been Proven

1. **Collateral returning to borrower** — BTC has gone into escrow but never come back out in a completed test
2. **Multi-party signing on Mutinynet** — borrower + lender sequential signing on the live testnet
3. **Server co-signing on Mutinynet** — `arkProvider.submitTx` with the Mutinynet Arkade server
4. **Checkpoint signing + finalizeTx on Mutinynet** — the final handshake that completes the release
5. **Balance verification after release** — proving the borrower actually has spendable sats again

### Why This Spike Must Pass Before Agent Work

The agent demo (AGENT-001/002) ends with the borrower repaying the loan and getting their collateral back via Path A. If the release doesn't work:

- Two deployed OpenClaw agents negotiate a loan, lock real testnet BTC, and then... nothing. The collateral is stuck.
- Debugging multi-party signing through two autonomous agents talking via Telegram is a nightmare.
- This spike isolates the hard crypto/SDK problem from the agent orchestration problem.

### Why Mutinynet, Not Regtest

The agents will operate on Mutinynet via the deployed Railway MCP servers. Regtest is a local Docker environment — different server, different timing, different behavior. A passing regtest test does not guarantee Mutinynet works. Known differences:

- Mutinynet has real block intervals (~30s) vs regtest (on-demand)
- Settlement rounds happen on server schedule, not instantly
- The Arkade server at `mutinynet.arkade.sh` may behave differently from local Docker
- Network latency affects PSBT round-trips

---

## Scope

### In Scope

- Full Path A escrow lifecycle on Mutinynet: fund → onboard → build escrow → lock → release → verify return
- Two separate wallet identities (borrower + lender) signing sequentially
- Arkade server co-signing as third party via `submitTx`
- Checkpoint signing and `finalizeTx`
- Balance verification: borrower wallet balance increases after release
- Standalone TypeScript test script (no MCP, no agents — direct SDK calls)

### Out of Scope

- Path B1, B2, C — different spike, different risk profile
- Two-output fair liquidation (surplus return) — future spike
- Running through MCP tools — this validates the SDK mechanism, tool wrapping is already proven
- Protocol Service integration — BACK-007 (server co-sign endpoint) is a separate story
- Agent integration — that's AGENT-001/002, gated on this spike passing

---

## Acceptance Criteria

- [ ] Connect to Mutinynet Arkade server at `https://mutinynet.arkade.sh`
- [ ] Create two wallet identities (borrower + lender) from random keys
- [ ] Fund borrower via Mutinynet faucet (`https://faucet.mutinynet.com`) — **manual step before running**
- [ ] Onboard borrower's boarding UTXO into a VTXO
- [ ] Build 4-path escrow (Path A, B1, B2, C) with borrower + lender + server pubkeys
- [ ] Lock BTC into escrow VTXO
- [ ] Query escrow VTXO from Arkade indexer
- [ ] Build offchain transaction (escrow → borrower)
- [ ] Borrower signs PSBT
- [ ] Lender signs the borrower-signed PSBT
- [ ] Submit double-signed PSBT to Arkade server (`submitTx`) — server co-signs
- [ ] Sign checkpoint transactions with both borrower and lender identities
- [ ] Finalize via `finalizeTx`
- [ ] Verify escrow is drained (0 spendable VTXOs at escrow script)
- [ ] Verify borrower wallet balance increased (or preconfirmed balance visible)
- [ ] Console output logs each sub-step with pass/fail

---

## Test Script

### File

```
btc-wallet-plugin/
└── reference/
    └── spike003-mutinynet-round-trip.ts
```

### Prerequisites

1. Node.js v22+
2. `cd reference && npm install` (dependencies already in reference/package.json)
3. Borrower wallet funded on Mutinynet:
   - Run `npm run keygen` → note the boarding address
   - Go to `https://faucet.mutinynet.com` → send tBTC to that address
   - Wait for confirmation (~30s)

### Approach

Adapt the existing `spike002-release-test.ts` reference code for Mutinynet:

| Change | From (SPIKE-002 regtest) | To (SPIKE-003 Mutinynet) |
|---|---|---|
| Server URL | `http://localhost:7070` | `https://mutinynet.arkade.sh` |
| Explorer URL | `http://localhost:3000` | `https://explorer.mutinynet.arkade.sh` |
| Network HRP | `regtest` | `mutinynet` |
| Faucet | HTTP POST to local esplora | Manual — human funds via web faucet before running |
| Wallet creation | Random ephemeral keys | Borrower from env var (pre-funded), lender from random |
| Polling timeouts | 60s | 120s (Mutinynet is slower) |
| Esplora dependency | Used for faucet | Not needed — no local esplora |

### Key Variables

```typescript
const ARK_URL = 'https://mutinynet.arkade.sh';
const NETWORK_HRP = 'mutinynet';  // or from networks object
const BORROWER_PRIVATE_KEY = process.env.BORROWER_PRIVATE_KEY;  // pre-funded
```

### Run Command

```bash
cd reference
BORROWER_PRIVATE_KEY=<hex> npx tsx spike003-mutinynet-round-trip.ts
```

---

## Human Verification Guide

### Setup (one-time, before running)

| Step | You do | Expected |
|---|---|---|
| 1 | Run `npm run keygen` in btc-wallet-plugin root | Prints private key hex + `tb1p...` boarding address |
| 2 | Copy the private key hex — you'll need it to run the spike | Key saved |
| 3 | Open `https://faucet.mutinynet.com` | Faucet page loads |
| 4 | Paste the `tb1p...` boarding address, request tBTC | Faucet confirms send |
| 5 | Wait ~60 seconds for block confirmation | |

### Run

| Step | You do | Expected |
|---|---|---|
| 6 | `cd reference && BORROWER_PRIVATE_KEY=<hex> npx tsx spike003-mutinynet-round-trip.ts` | Script starts |
| 7 | Read console | Step 1: "Connected to mutinynet.arkade.sh" |
| 8 | Read console | Step 2: "Borrower restored, Lender created" — two identities |
| 9 | Read console | Step 3: "Escrow constructed — 4 paths, tark1..." address |
| 10 | Read console | Step 4: "Onboard complete — X sats available" |
| 11 | Read console | Step 5: "Collateral locked — txid, explorer URL" |
| 12 | Read console | Step 6: "Escrow VTXO found — value matches" |
| 13 | Read console | Step 7: "Offchain tx built, borrower signed, lender signed" |
| 14 | Read console | Step 8: "Server accepted: [arkTxid]" — **this is the critical moment** |
| 15 | Read console | Step 9: "Checkpoints signed, finalized" |
| 16 | Read console | Step 10: "Escrow drained, borrower balance increased" |
| 17 | Read console | "SPIKE-003 COMPLETE — full escrow round-trip on Mutinynet" |

### What Failure Looks Like

| Step | Failure | Likely cause |
|---|---|---|
| 7 | Connection refused | Mutinynet server down or URL wrong |
| 10 | "Boarding balance: 0" after timeout | Faucet tx not confirmed yet — wait longer or re-fund |
| 11 | "Insufficient balance" | Faucet amount too small or onboard fees consumed it |
| 12 | VTXO not found after timeout | Escrow address mismatch or locking failed silently |
| 13 | `identity.sign()` throws | PSBT format issue — compare with regtest PSBT structure |
| 14 | `submitTx` rejected by server | **Most likely failure point.** Invalid signatures, wrong leaf selection, or server doesn't recognize the escrow script. Log full error and PSBT hex for debugging. |
| 15 | Checkpoint signing throws | Wrong signing index or identity mismatch |
| 16 | Escrow not drained after timeout | Finalize didn't complete — server may need a settlement round |
| 16 | Borrower balance unchanged | Offchain tx accepted but not yet settled — may need to wait for next round |

---

## Definition of Done

- [ ] Path A collaborative release executes end-to-end on Mutinynet
- [ ] BTC moves from escrow back to borrower's wallet (balance increase verified)
- [ ] Full lifecycle proven on production testnet: fund → onboard → lock → release → verify
- [ ] Any Mutinynet-specific deviations from regtest behavior are documented
- [ ] Script runs reproducibly with a pre-funded wallet key
- [ ] GO/NO-GO decision recorded for agent implementation

---

## Findings Template

After running, document results in `reference/SPIKE003_FINDINGS.md`:

```markdown
# SPIKE-003 Findings: Escrow Round-Trip on Mutinynet

## Result: GO / NO-GO

## Environment
- Date: YYYY-MM-DD
- Arkade SDK version: x.y.z
- Mutinynet server: https://mutinynet.arkade.sh
- Node.js version: x.y.z

## Timing
- Fund → onboard: Xs
- Onboard → lock: Xs
- Lock → release (Path A): Xs
- Release → balance visible: Xs
- Total: Xs

## Observations
- (any surprising behavior, timing, error messages)

## Deviations from Regtest
- (differences in API responses, timing, PSBT format, etc.)

## Impact on Agent Design
- (anything the agents need to account for: polling intervals, retry logic, etc.)
```

---

## Reference

- **SPIKE-002 reference code:** `reference/spike002-release-test.ts` — regtest Path A release (adapt for Mutinynet)
- **SPIKE-001:** `LoanMarketPlace/docs/user stories/SPIKE001_arkade_escrow_validation.md`
- **SPIKE-002:** `LoanMarketPlace/docs/user stories/SPIKE002_escrow_release_validation.md`
- **Arkade SDK:** `https://arkade-os.github.io/ts-sdk/`
- **Mutinynet faucet:** `https://faucet.mutinynet.com`
- **Mutinynet explorer:** `https://explorer.mutinynet.arkade.sh`
- **Key generation:** `npm run keygen` in btc-wallet-plugin root
