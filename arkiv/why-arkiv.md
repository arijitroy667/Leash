# Why Arkiv

A shared safety registry needs three things: nobody controls the data, bad records don't last forever, and any agent can look up a merchant cheaply just before paying. Each one matches an Arkiv feature.

## What users would lose on Postgres

| On Arkiv | On Postgres |
| --- | --- |
| Any agent, from any team, writes its own reports from its own wallet | Someone runs the database and decides who may write, so every agent must trust that operator |
| Each entity's owner and creator are recorded by the network, and the owner is part of what the payer signs | Authorship is whatever the operator's tables say |
| Expiry is enforced by the network, so a block ends when its evidence does | Forgetting is a cleanup job the operator promises to run |
| Anyone reads it with one query and no key: our public explorer holds no secret | A public read API we would have to build, secure and keep online |
| If our servers disappear, the evidence stays readable until it expires | If our database goes down, every guard is blind |

## Expiry is forgiveness

A blacklist that never forgets is unfair, and one that forgets too easily is useless. Leash writes every report with a real expiry. A strike only exists while the evidence behind it does, so no merchant can be blocked forever by old data, and nobody has to run a cleanup job or decide who gets a pardon.

| | Production | Live demo profile |
| --- | --- | --- |
| Entity lifetime | 60 days | 18 minutes by default |
| Strike memory | 60 days | Shortened by the same ratio |

On a regular database or a permanent chain, we would have to build deletion ourselves and ask people to trust it. Here the network enforces it.

## Wallet-owned entities

Each report is owned by the wallet that wrote it, and that owner is part of what the payer signs. This gives us:

- **Attribution:** a reader can see who wrote each report.
- **No replay:** a signature copied into another wallet's entity fails, because the owner is in the signed message.
- **No central operator:** we hold no special write access. If our servers disappear, the evidence stays readable until it expires.

## Attribute queries

The question asked before each payment is simple: "what does the evidence say about this payee, newest first?" Indexed attributes answer it directly:

```ts
publicClient.select().from(ReportSchema)
  .where(and(eq("ns", "mumbai-1"), eq("payee", "0.0.123")))
  .orderBy(desc("consensusTs")).limit(100).fetch();
```

We don't need an indexer, a subgraph or our own API. A guard on any machine can run this query, and so can the public explorer.

## What Arkiv does not do for us

Arkiv stores claims and does not judge them. Anyone can write a false report, so every reader re-verifies each row against Hedera Mirror Node and the payer's signature. Hedera proves the payment happened, ENS says who the merchant claims to be, and Arkiv holds the shared memory that links them.

## What we kept off Arkiv, and why

| Data | Where it lives | Why not Arkiv |
| --- | --- | --- |
| Spend ledger, replay store, pending approvals and the outbox | SQLite on the agent owner's machine | Private to one owner, and they need atomic updates: one payment per challenge, a single-use approval. They must also keep working when Arkiv is down |
| The payment and its proof | Hedera, read through Mirror Node | An Arkiv row is a claim. The payment is the proof, so it stays where it settled |
| The merchant's identity and payment declaration | ENSv2 text records | The merchant controls them, and ENSv2 roles let it delegate one key, such as `leash.rebuttal` |
| The audit log of every decision | Hedera HCS topic `0.0.11326849` | It must be ordered and kept for good. Registry evidence must expire |
| Free text, such as notes or merchant messages | Nowhere | Text from an LLM or a merchant can carry instructions to another agent. Reasons are stored as fixed codes |
| Keys | Only in each owner's `.env` | Never shared |
