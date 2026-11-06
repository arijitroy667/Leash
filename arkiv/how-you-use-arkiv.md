# How we use Arkiv

SDK `@arkiv-network/sdk` 1.0.1 on chain `rabdi`. The adapter is `packages/guard/src/arkiv.ts`, and columns are listed in `schema.md`.

## Each Arkiv feature, and what users see because of it

| Arkiv feature | How Leash uses it | What users see |
| --- | --- | --- |
| Indexed attributes, `eq` on `ns` and `payee` | The standing query before every payment | The verdict their agent gets, and the merchant's health bar in the explorer |
| `eq` on `payer` | Each bad reporter's history, for the limit of 5 a day | A flood of bad reports from one wallet cannot block a merchant |
| `eq` on `domain` | Finds a merchant from its website | `leash_check_merchant` and the explorer's lookup accept a domain |
| `eq` on `txId`, with `$creator` | Checks before writing, so one payment gives one report | No double counting, even when a write is retried |
| `$creator` | A probe counts only if an allow-listed prober created it | Probe results in the explorer; a forged probe handed to the prober's address is ignored (F13) |
| A numeric attribute, `consensusTs`, sorted newest first, with `lte` | Newest evidence first, and rows dated in the future are never fetched | The latest reports with their HashScan links; a flood of fake newer rows cannot hide real ones (F15) |
| Expiry | Evidence lives 60 days in production and 18 minutes on the demo clock | Blocks end and health bars recover when the evidence behind them expires |
| `count` | Live totals per namespace | The registry counts on the landing page, which fall as entities expire |
| Reads with no access key | The public explorer holds no secret | Anyone can look a merchant up, with no login or wallet |

## Who can edit each entity

Leash creates every entity with Arkiv's default flags, so only its owner can update, delete or extend it, or hand it to another wallet. Leash writes each entity once and never edits it.

- **An edited report** no longer matches its signature, so every reader ignores it.
- **A deleted report** is the same as one that expired early: a reporter can withdraw its own claim, never anyone else's.
- **A probe handed to the prober's address** still does not count, because readers check its creator, which never changes.

This fits a registry of claims: the writer answers for its own row, and the reader decides what counts.

## Write path

A write never holds up a payment or a response.

1. The guard pays over x402 and checks what was delivered: status, content type and the fields declared in `leash.schema`.
2. It adds a report to a local SQLite outbox. The dedupe key is agent plus transaction id, so one payment gives one report.
3. The outbox worker waits for Mirror Node to show the payment, then takes the real payer and consensus time from there.
4. The payer's Hedera key signs `leash.report:v1|ns|txId|payee|outcome|amountMicroUsd|arkivOwner`.
5. The wallet creates the entity with its expiry. Failures retry with backoff.

An item is claimed atomically before it is sent. Our first rehearsal wrote one report twice because two flushes raced, and the claim step fixed that.

Probes are written the same way by the prober wallet after a real paid retest. Rebuttals are signed by the wallet holding the merchant's ENS role, then written by the prober wallet or the console.

## Read path

Before each payment, the guard:

1. Queries reports, probes and rebuttals for the payee, by `ns` and `payee`, newest first.
2. Re-verifies each report on Mirror Node: the payment succeeded, the token, payee, payer and amount match, and the payer's key signed it. Rows that fail are ignored, and the explorer shows them as ignored with the reason.
3. Takes time from Mirror Node, never from the entity, and drops any row whose stated time disagrees.
4. Queries each bad reporter's history by `payer`, because a reporter's sixth bad report in a day is ignored whichever payee it names. Only verified rows count, so forged rows cannot use up a victim's allowance.
5. Replays the verified evidence in consensus order through the pure engine in `packages/core`, which gives the merchant's standing.

## Reader caps

| Cap | Value | Why |
| --- | --- | --- |
| Query page | 100 rows | The node's limit; the SDK throws above it |
| Reports read per payee | 200, over two pages | Bounds latency and Mirror calls |
| Bad reports read per reporter | 100 | Bounds the daily-limit check; skipped entirely for a reporter with 5 or fewer |
| Verdict cache by transaction id | Local SQLite | A verified payment does not need rechecking |

A payee with more than 200 live reports is judged on the newest 200.

## When Arkiv is unavailable

We tested this by cutting Arkiv traffic at a local relay.

- **Cached block:** a merchant already known to be blocked is still denied.
- **No cached evidence:** the guard escalates to the owner with `registry-unavailable`. It does not guess and allow.
- **Queued reports:** they stay in the outbox and are sent when Arkiv returns.

## Namespaces

`ns` separates registries. Each rehearsal uses a new one, since data is real and can't be reset by hand. `mumbai-prod` uses the production profile and 60-day expiry, and demo runs use the live profile with 18-minute expiry.
