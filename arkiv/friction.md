# Friction log

Kept live during the build. The three issues that cost us most come first, each with what we expected, what happened and how to reproduce it.

## 1. The access key ends up in error messages and logs

- **Expected:** an error that names the endpoint without the key.
- **What happened:** `rabdi({ accessKey })` puts the key in the RPC URL's path, and any request error quotes that URL. A crash log printed our key.
- **Repro**, with a made-up key:

  ```ts
  const c = createPublicClient({ chain: rabdi({ accessKey: "FAKE-KEY-123" }), transport: http(undefined, { timeout: 1 }) });
  await c.getBlockNumber();
  // TimeoutError ... URL: https://rpc.rabdi.db-chain.testnet.arkiv.network/FAKE-KEY-123
  ```

- **What would fix it:** send the key in a header, so no URL carries it. Until then we strip URLs from everything we log.

## 2. Three names for one thing

- **Expected:** one name for an entity's lifetime, and one testnet name, across the SDK README, the docs and the AI skill files.
- **What happened:** they say `expiresIn`, `expires` and `expiration`, and name three testnets: kaolin, tiramisu and rabdi. The README example shows `ExpirationTime.fromDays`, while shorter lifetimes with `fromSeconds` appear only in the types.
- **Repro:** compare those three sources with the installed package's types in `node_modules/@arkiv-network/sdk/dist/*.d.ts`. The types say `expiration`, on Rabdi, and were the only reliable source.
- **What would fix it:** one versioned docs page per SDK major version.

## 3. No newest-first by creation time

- **Expected:** `orderBy(desc("$createdAt"))` to read the newest reports first.
- **What happened:** `$createdAt` comes back with each row but is not indexed, so it can be neither filtered on nor sorted by.
- **Repro:** the SDK's own comment on `QUERYABLE_SYSTEM_ATTRIBUTES` says so.
- **What we did:** our own indexed column, `consensusTs`, which we wanted anyway because Hedera's clock is the trusted one.

## Smaller notes

- A query page is capped at 100 rows, and the SDK throws on a higher limit before sending. Clear error, good. We page twice for our 200-report reader cap.
- A `str` value is capped at 128 bytes. A 64-byte signature in hex just fits, but a 65-byte EVM signature does not, so it goes in a `bytes` column. The error message told us exactly that, which saved time.
- Reads work with no access key, through a public endpoint the SDK warns is heavily rate limited. That makes a public explorer possible with no secret, so we cache its responses for 5 seconds.
- We hit occasional read timeouts on the testnet during rehearsals. Reads now retry in the demo runner, and guards escalate rather than guess.
- A batch of 50 creates failed, while batches of 10 and 25 went through. We write floods for our tests in batches of 10.

## Disclosure: live policy profile

The demo runs with `LEASH_POLICY_PROFILE=live`, by default 1 policy day = 18 real seconds with blocks of 1, 2 and 5 minutes, set in `.env` and shown on screen. It shortens block, hold, cooldown, strike-memory and entity-expiry durations. It is not a moved clock: timestamps come from Hedera consensus, Arkiv entities really expire, and every payment is real on testnet. Fixtures and defaults use the `production` profile.

## Other sponsors, recorded for the debrief

- ENSv2: the deployed `PermissionedResolver` matches the docs (`initialize((address,uint256)[],bytes[])`, `setText(bytes,string,string)`), while `contracts-v2` `main` on GitHub has a different `initialize` and `setText(bytes32,...)`. We checked each selector against live bytecode.
- x402: the Hedera README's server example uses asset `0.0.6001`, which does not exist on testnet. USDC is `0.0.429274`.
- Hiero SDK 2.90: `AccountBalanceQuery` still exists but throws at runtime as deprecated. Mirror Node REST works.
- x402 Hedera: configuring two facilitators made the advertised `feePayer` vary by deployment.
