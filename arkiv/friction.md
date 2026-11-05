# Friction log

Kept live during the build. Newest findings are added at the end.

## Arkiv

- The SDK's own README, older docs and skill files disagree: `expiresIn` versus `expires` versus `expiration`, and three different testnet names (kaolin, tiramisu, rabdi). The types in the installed package were the only reliable source. Most useful single fix: one versioned docs page per SDK major.
- `$createdAt` cannot be used in `orderBy`, so newest-first needs our own indexed column. We use `consensusTs`, which we wanted anyway because Hedera's clock is the trusted one.
- The README example shows `ExpirationTime.fromDays`, while shorter lifetimes (`fromSeconds`) are only visible in the types.

- A query page is capped at 100 rows, and the SDK throws on a higher limit before sending. Clear error, good. We page twice for our 200-report reader cap.

## Disclosure: live policy profile

The demo runs with `HERD_POLICY_PROFILE=live`, where 1 policy day = 18 real seconds, shown on screen. It shortens block, hold, cooldown, strike-memory and entity-expiry durations. It is not a moved clock: timestamps come from Hedera consensus, Arkiv entities really expire, and every payment is real on testnet. Fixtures and defaults use the `production` profile.

## Other sponsors, recorded for the debrief

- ENSv2: the deployed `PermissionedResolver` matches the docs (`initialize((address,uint256)[],bytes[])`, `setText(bytes,string,string)`), while `contracts-v2` `main` on GitHub has a different `initialize` and `setText(bytes32,...)`. We checked each selector against live bytecode.
- x402: the Hedera README's server example uses asset `0.0.6001`, which does not exist on testnet. USDC is `0.0.429274`.
- Hiero SDK 2.90: `AccountBalanceQuery` still exists but throws at runtime as deprecated. Mirror Node REST works.
- x402 Hedera: configuring two facilitators made the advertised `feePayer` vary by deployment.
- A `str` value is capped at 128 bytes. A 64-byte signature in hex just fits, but a 65-byte EVM signature does not, so it goes in a `bytes` column. The error message told us exactly that, which saved time.
