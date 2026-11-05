# How we use Arkiv

SDK `@arkiv-network/sdk` 1.0.1 on chain `rabdi`. The adapter is `packages/guard/src/arkiv.ts`, and columns are listed in `schema.md`.

## Write path

A write never holds up a payment or a response.

1. The guard pays over x402 and checks what was delivered: status, content type and the fields declared in `herd.schema`.
2. It adds a report to a local SQLite outbox. The dedupe key is agent plus transaction id, so one payment gives one report.
3. The outbox worker waits for Mirror Node to show the payment, then takes the real payer and consensus time from there.
4. The payer's Hedera key signs `herd.report:v1|ns|txId|payee|outcome|amountMicroUsd|arkivOwner`.
5. The wallet creates the entity with its expiry. Failures retry with backoff.

An item is claimed atomically before it is sent. Our first rehearsal wrote one report twice because two flushes raced, and the claim step fixed that.

Probes are written the same way by the prober wallet after a real paid retest. Rebuttals are signed by the wallet holding the merchant's ENS role, then written by the prober wallet or the console.

## Read path

Before each payment, the guard:

1. Queries reports, probes and rebuttals for the payee, by `ns` and `payee`, newest first.
2. Re-verifies each report on Mirror Node: the payment succeeded, the token, payee, payer and amount match, and the payer's key signed it. Rows that fail are ignored, and the explorer shows them as ignored with the reason.
3. Takes time from Mirror Node, never from the entity.
4. Replays the verified evidence in consensus order through the pure engine in `packages/core`, which gives the merchant's standing.

## Reader caps

| Cap | Value | Why |
| --- | --- | --- |
| Query page | 100 rows | The node's limit; the SDK throws above it |
| Reports read per payee | 200, over two pages | Bounds latency and Mirror calls |
| Verdict cache by transaction id | Local SQLite | A verified payment does not need rechecking |

A payee with more than 200 live reports is judged on the newest 200.

## When Arkiv is unavailable

We tested this by cutting Arkiv traffic at a local relay.

- **Cached block:** a merchant already known to be blocked is still denied.
- **No cached evidence:** the guard escalates to the owner with `registry-unavailable`. It does not guess and allow.
- **Queued reports:** they stay in the outbox and are sent when Arkiv returns.

## Namespaces

`ns` separates registries. Each rehearsal uses a new one, since data is real and can't be reset by hand. `mumbai-prod` uses the production profile and 60-day expiry, and demo runs use the live profile with 18-minute expiry.
