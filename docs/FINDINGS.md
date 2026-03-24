# SPIKE Findings: Arkade Escrow Validation

**Date:** 2026-03-15 (updated 2026-03-16)
**SDK version:** @arkade-os/sdk 0.3.13
**Server:** Local regtest (arkd v0.9.0 via Docker) + mutinynet.arkade.sh (Mutinynet testnet)
**Recommendation:** **GO** — proceed with backend development

---

## Summary

The Arkade SDK fully supports constructing a 4-path escrow VtxoScript and executing the fund → lock → release flow end-to-end. All script types, address derivation, identity management, VTXO onboarding, collateral locking, and Path A collaborative spend work as expected. Validated on local regtest environment (Steps 1-8 all pass).

## Results by Step

| Step | Description | Result |
|---|---|---|
| 1 | Server connection | PASS (regtest + Mutinynet) |
| 2 | Wallet creation (SingleKey identity) | PASS |
| 3 | 4-path escrow VtxoScript construction | PASS |
| 4 | Fund from faucet + onboard to VTXOs | PASS (regtest) |
| 5 | Lock collateral into escrow | PASS (regtest — 99,999,000 sats locked) |
| 6 | Path A collaborative spend | PASS (SPIKE-002) — see below |
| 7 | Verification (balance + escrow drained) | PASS (SPIKE-002) — see below |

## Confirmed SDK APIs

### Identity

```typescript
import { SingleKey } from '@arkade-os/sdk';

const identity = SingleKey.fromRandomBytes();
const pubkey = await identity.xOnlyPublicKey(); // 32-byte Uint8Array
const hex = identity.toHex();                   // private key for recovery
```

- `SingleKey.fromRandomBytes()` works (plan assumed it might not exist)
- `SingleKey.fromHex(privateKeyHex)` also available
- `MnemonicIdentity` not needed — `SingleKey` has full `xOnlyPublicKey()` + `sign()` support
- `SingleKey.fromPrivateKey()` also exported

### Script Construction

```typescript
import {
  MultisigTapscript,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  VtxoScript,
  networks,
} from '@arkade-os/sdk';

// Path A: mutual release (borrower + lender + server)
const pathA = MultisigTapscript.encode({
  pubkeys: [borrowerPub, lenderPub, serverPub],
}).script;

// Path B: lender default/liquidation (lender + server, 7-day absolute timelock)
const pathB = CLTVMultisigTapscript.encode({
  pubkeys: [lenderPub, serverPub],
  absoluteTimelock: BigInt(Math.floor(Date.now() / 1000)) + 86400n * 7n,
}).script;

// Path C: borrower safety exit (borrower + server, 14-day relative timelock)
const pathC = CSVMultisigTapscript.encode({
  pubkeys: [borrowerPub, serverPub],
  timelock: { type: 'blocks', value: 2016 }, // 14 days * 144 blocks/day
}).script;

// Combine into escrow
const escrowScript = new VtxoScript([pathA, pathB, pathC]);
const escrowAddress = escrowScript.address(networks.mutinynet.hrp, serverPub).encode();
// → "tark1q..."
```

### Key API Deviations from Spec / SKILL.md

| Spec assumed | Actual SDK API | Impact |
|---|---|---|
| `MultisigTapscript.new({ publicKeys, m })` | `MultisigTapscript.encode({ pubkeys }).script` | Different method name and param names; no `m` param (always n-of-n) |
| `CSVMultisigTapscript` with `relativeTimelock` | `.encode({ pubkeys, timelock: { type, value } })` | **Must use `type: "seconds"`** — server rejects `"blocks"` |
| CSV seconds value — any integer | Must be a **multiple of 512** (BIP68 requirement) | Use `Math.ceil(days * 86400 / 512) * 512` |
| `SingleKey` might lack `xOnlyPublicKey()` | Fully supported: `fromRandomBytes()`, `xOnlyPublicKey()`, `sign()` | No fallback to `MnemonicIdentity` needed |
| Network HRP unclear | `networks.mutinynet.hrp === "tark"` | Use `networks.mutinynet` (not `networks.bitcoin`) for testnet |
| `.new()` factory pattern | `.encode()` pattern across all script types | Consistent: `encode()` / `decode()` / `is()` on all tapscript types |

### VtxoScript Methods

| Method | Returns | Purpose |
|---|---|---|
| `new VtxoScript([...scripts])` | VtxoScript | Combine tap leaves |
| `.address(hrp, serverPubkey)` | ArkAddress (call `.encode()` for string) | Derive escrow address |
| `.pkScript` | Uint8Array | For indexer queries |
| `.findLeaf(hexScript)` | TapLeafScript | For building spend transactions |
| `.encode()` | Uint8Array | Full tap tree encoding |
| `.exitPaths()` | — | For unilateral exit enumeration |

### Server Info

| Field | Value | Notes |
|---|---|---|
| `network` | `mutinynet` | Signet-based testnet |
| `signerPubkey` | 33-byte compressed | Slice first byte for x-only (32-byte) |
| `checkpointTapscript` | hex-encoded CSVMultisigTapscript | Decode with `CSVMultisigTapscript.decode()` |
| `unilateralExitDelay` | 172544 | ~20 days in blocks |
| `boardingExitDelay` | 15552000 | ~180 days in seconds |
| `dust` | 330 sats | Minimum VTXO amount |

### Available Networks

`networks` exports: `bitcoin`, `testnet`, `signet`, `mutinynet`, `regtest` — each with `{ bech32, pubKeyHash, scriptHash, wif, hrp }`.

## Blocker: Mutinynet Server Boarding Flow

**Error:** `INTERNAL_ERROR (0): failed to watch boarding scripts: rpc error: code = Unknown desc = failed to add addresses to group: HTTP 500`

**Where it fails:** `Ramps.onboard()` → `Wallet.settle()` → `Wallet.safeRegisterIntent()` → `RestArkProvider.registerIntent()` (POST to `/v1/batch/registerIntent`)

**Root cause:** The Arkade server's internal connection to its Bitcoin node/Esplora backend is returning HTTP 500 when trying to watch new boarding addresses. This is entirely server-side — the client SDK is functioning correctly.

**Scope:** Only `mutinynet.arkade.sh` is affected. The only other reachable server (`arkade.computer`) is mainnet and requires real BTC.

**Mitigation for production:**
- Backend should implement retry logic with backoff around `Ramps.onboard()` and `registerIntent`
- Health check endpoint: `arkProvider.getInfo()` succeeds even when boarding is broken, so a dedicated boarding health probe is needed
- Consider running a self-hosted Arkade server ([arkade-os/arkd](https://github.com/arkade-os/arkd)) for production reliability

## Previously Unvalidated — Now Validated (SPIKE-002)

These items were deferred during SPIKE-001 due to Mutinynet server issues, then validated on local regtest in SPIKE-002:

1. **`buildOffchainTx([inputs], outputs, serverUnrollScript)`** — construct offchain spend transaction **WORKS**
2. **Multi-party signing** — sequential `identity.sign()` with borrower then lender **WORKS**
3. **`arkProvider.submitTx()` / `finalizeTx()`** — server co-signing and checkpoint finalization **WORKS**
4. **Path A collaborative release** — full spend flow end-to-end **WORKS**

See SPIKE-002 section below for confirmed API patterns.

### Now Validated (updated 2026-03-16)

These items were previously unvalidated and are now confirmed working on local regtest:

1. **`wallet.sendBitcoin({ address: escrowAddress, amount })`** — VTXO transfer to custom VtxoScript address **WORKS**
2. **`Ramps.onboard()`** — boarding UTXO to VTXO conversion **WORKS** (requires server wallet to be funded)
3. **`wallet.getBalance()`** — balance detection including boarding UTXOs **WORKS**
4. **`EventSource` polyfill** — `eventsource` npm package works with arkd's SSE stream

## Local Development Setup

The Mutinynet public server (`mutinynet.arkade.sh`) had a broken internal Esplora backend (`mutinynet.ltbl.io` returning HTTP 500). The solution is a local regtest environment via Docker. See `REQUIREMENTS.md` for setup instructions.

**Key discovery:** The Arkade server needs its own BTC liquidity to build VTXO trees for batch settlement. On Mutinynet this is pre-funded. On local regtest, you must fund the server wallet via the faucet after initialization.

**Node.js requirement:** The SDK uses `EventSource` (browser API) for batch settlement streams. In Node.js, install and polyfill it:
```typescript
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;
```

## Recommendation

### GO

**Proceed with backend development.** The full escrow lifecycle — create, lock, AND release — is validated end-to-end with running code on local regtest. BTC goes in and comes back out via Path A collaborative spend.

**Action items:**

1. **Use local regtest** for all development (not Mutinynet — unreliable public infrastructure)
2. **Self-host Arkade server** for production (eliminates dependency on third-party server health)
3. **Use the confirmed API patterns above** (not the SKILL.md patterns) when implementing `ContractBuilderSkill` and `ArkadeVerifierSkill`
4. **Add `eventsource` polyfill** to any Node.js code that uses the Arkade SDK
5. ~~**Test Path A collaborative spend**~~ — **DONE** (SPIKE-002, 2026-03-16)

---

## SPIKE-002: Path A Collaborative Spend (2026-03-16)

**Script:** `spike002-release-test.ts`
**Status:** **PASS** — all 8 steps pass on local regtest (2026-03-16)
**Spend txid:** `0a6019b8354e037594533f1ad325280e3845755418da16725609ce49665a7230`

### Confirmed Path A Spend API Pattern

```typescript
import { buildOffchainTx, Transaction } from '@arkade-os/sdk';
import { base64 } from '@scure/base';

// 1. Query escrow VTXOs
const { vtxos } = await indexerProvider.getVtxos({
  scripts: [hex.encode(escrowScript.pkScript)],
  spendableOnly: true,
});

// 2. Decode server checkpoint script
const serverUnrollScript = CSVMultisigTapscript.decode(
  hex.decode(serverInfo.checkpointTapscript),
);

// 3. Build recipient (borrower's standard 2-of-2 VTXO)
const recipientScript = new VtxoScript([
  MultisigTapscript.encode({ pubkeys: [borrowerPubkey, serverPubkey] }).script,
]);

// 4. Build offchain tx
const input = {
  txid: vtxo.txid,
  vout: vtxo.vout,
  value: vtxo.value,
  tapLeafScript: escrowScript.findLeaf(hex.encode(pathAScript)),
  tapTree: escrowScript.encode(),
};
const outputs = [{ amount: BigInt(vtxo.value), script: recipientScript.pkScript }];
const { arkTx, checkpoints } = buildOffchainTx([input], outputs, serverUnrollScript);

// 5. Sequential signing: borrower → lender
const signedByBorrower = await borrowerIdentity.sign(Transaction.fromPSBT(arkTx.toPSBT()));
const signedByBoth = await lenderIdentity.sign(Transaction.fromPSBT(signedByBorrower.toPSBT()));

// 6. Submit to server (server co-signs)
const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
  base64.encode(signedByBoth.toPSBT()),
  checkpoints.map((c) => base64.encode(c.toPSBT())),
);

// 7. Sign checkpoints with both identities at index [0]
const finalCheckpoints = await Promise.all(
  signedCheckpointTxs.map(async (cpB64) => {
    const cpBorrower = await borrowerIdentity.sign(Transaction.fromPSBT(base64.decode(cpB64)), [0]);
    const cpBoth = await lenderIdentity.sign(Transaction.fromPSBT(cpBorrower.toPSBT()), [0]);
    return base64.encode(cpBoth.toPSBT());
  }),
);

// 8. Finalize
await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
```

### Key API Notes

| API | Detail |
|---|---|
| `buildOffchainTx` input `value` | Can be `number` — SDK converts to BigInt internally |
| `buildOffchainTx` output `amount` | Must be `BigInt` — pass `BigInt(vtxo.value)` |
| `escrowScript.findLeaf(hexScript)` | Takes hex-encoded script string, returns `TapLeafScript` |
| `escrowScript.encode()` | Returns full tap tree as `Uint8Array` |
| `identity.sign(tx, [indexes])` | Optional index array for checkpoint signing (always `[0]`) |
| `arkProvider.submitTx` | Direct POST to `/v1/tx/submit` — no SSE/EventSource needed |
| `arkProvider.finalizeTx` | Direct POST to `/v1/tx/finalize` — no SSE/EventSource needed |

### Critical Finding: CSV Must Use Seconds, Not Blocks

The Arkade server rejects VTXOs with block-based CSV timelocks:
```
INVALID_VTXO_SCRIPT (10): invalid exit closure, CSV block type not allowed
```

**Wrong:** `CSVMultisigTapscript.encode({ pubkeys, timelock: { type: 'blocks', value: 2016 } })`
**Correct:** `CSVMultisigTapscript.encode({ pubkeys, timelock: { type: 'seconds', value: Math.ceil(14 * 86400 / 512) * 512 } })`

The value must be a multiple of 512 (BIP68 requirement). This error only surfaces at `submitTx` time — locking BTC into a block-based CSV escrow succeeds, but spending from it fails. The server's own `checkpointTapscript` uses seconds-based CSV.

### Balance Verification Note

After Path A spend, the released funds go to a new recipient VTXO (borrower+server 2-of-2). The borrower wallet's `getBalance()` may not immediately reflect the increase — the escrow drain (0 VTXOs remaining at escrow address) is the definitive proof that the spend worked.
