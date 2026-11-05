# Arkiv schema

All entities are wallet-owned and expiring. An entity is data, never a verdict: readers re-verify every row before it counts. Column definitions live in `packages/guard/src/arkiv.ts`.

## `leash.report`

Filed automatically by the paying guard after its delivery check.

| Column | Type | Indexed | Meaning |
| --- | --- | --- | --- |
| `ns` | str | yes | Registry namespace, separates runs |
| `payee` | str | yes | Hedera account paid |
| `ens` | str | yes | ENS name claimed by the merchant, or empty |
| `domain` | str | yes | Origin of the real request. Not covered by the signature, so readers check it against ENS |
| `outcome` | str | yes | `good` or `bad` |
| `txId` | str | yes | Hedera transaction proving payment |
| `payer` | str | yes | Account debited, which is not the account in the transaction id |
| `payerSig` | str | no | Signature by the payer's Hedera key |
| `consensusTs` | u64 | yes | Consensus time; readers replace it with Mirror Node's value |
| `amountMicroUsd` | u64 | no | Amount in USDC atomic units |
| `reason` | str | no | Enum such as `delivered` or `schema-mismatch` |
| `v` | i32 | no | Schema version; readers ignore versions they do not know |

The signed message is `leash.report:v1|ns|txId|payee|outcome|amountMicroUsd|arkivOwner`, so a signature cannot be replayed by another wallet or for another outcome.

## `leash.rebuttal`

Signed by the wallet holding `ROLE_SET_TEXT` on the merchant resolver's `leash.rebuttal` key. The name must also declare that payee in ENS, so nobody can burn another merchant's rebuttal. It queues a probe and never unblocks alone. Columns: `ns`, `payee`, `ens`, `reason` (enum), `evidenceHash`, `episodeStart`, `filedAt`, `signer`, `signature` (bytes), `v`. Free text is never stored.

## `leash.probe`

Written by allow-listed prober wallets after a real paid retest. Columns: `ns`, `payee`, `result` (`pass` or `fail`), `txId`, `consensusTs`, `amountMicroUsd`, `deliveryDigest`, `v`.

## Expiry

| Entity | Production | Live profile |
| --- | --- | --- |
| All three | 60 days | 18 minutes by default: 60 policy days, or twice the total of the blocks if longer |

Expiry is the forgiveness mechanism: when evidence expires, so do the strikes built on it, so no merchant is blocked forever. The PRD's 30-day rebuttal expiry is simplified to match reports, since a rebuttal only matters while a block it refers to is still in evidence.

## Query

Newest reports for one payee, with a page of up to 100 rows:

```ts
publicClient.select().from(ReportSchema)
  .where(and(eq("ns", "mumbai-1"), eq("payee", "0.0.123")))
  .orderBy(desc("consensusTs")).limit(100).fetch();
```
