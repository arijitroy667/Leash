# Why Arkiv

A shared safety registry needs three things: nobody controls the data, bad records don't last forever, and any agent can look up a merchant cheaply just before paying. Each one matches an Arkiv feature.

## Expiry is forgiveness

A blacklist that never forgets is unfair, and one that forgets too easily is useless. Leash writes every report with a real expiry. A strike only exists while the evidence behind it does, so no merchant can be blocked forever by old data, and nobody has to run a cleanup job or decide who gets a pardon.

| | Production | Live demo profile |
| --- | --- | --- |
| Entity lifetime | 60 days | 18 minutes |
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
