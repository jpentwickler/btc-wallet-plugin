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
