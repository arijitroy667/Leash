# Reach: who can read and write the registry

The registry belongs to no one in this project. It is a set of public Arkiv entities, and the rules for using them are in open-source code.

## Reading

Anyone can read it, with no key, wallet or account. Our public explorer runs with no access key, and this query does too:

```bash
npx tsx apps/demo/src/arkiv-query.ts mumbai-prod 0.0.11323813
```

Any other guard, wallet or dashboard can use the same data. It needs only the schema in `schema.md` and the verification rules below.

## Writing

Arkiv lets any funded wallet write an entity, so being written does not make a row count. Each reader decides that by checking it.

| Entity | Who can write one | When a reader counts it |
| --- | --- | --- |
| `leash.report` | Any wallet | The payment exists on Mirror Node, succeeded, used the configured USDC, and matches the payee, payer and amount, and the payer's Hedera key signed the report. Only one bad report per payer per payee counts in the window, and at most 5 a day across payees |
| `leash.probe` | Any wallet | The owner is on that reader's prober allow-list, and the payment is real and went to that payee |
| `leash.rebuttal` | Any wallet | The named ENS record declares that payee, and the signer holds `ROLE_SET_TEXT` for the `leash.rebuttal` key on that resolver. It only asks for a probe and never unblocks a merchant |

So a stranger can join in by paying a merchant and reporting honestly, with no sign-up. A report costs a real payment, and it counts only for the wallet that paid.

## Limits of this reach

- **Prober allow-list:** each reader chooses which probers it trusts. Our default trusts only our own prober, so this part is not open yet.
- **Separate namespaces:** each `ns` is its own registry. Agents protect each other only when they read the same one.
- **Sybil resistance is partial:** funding-source clusters and age weighting raise the cost of faking several reporters, but a well-funded attacker can still get past them.
- **Testnet only:** everything here runs on Arkiv's `rabdi` testnet and Hedera testnet.
- **Other agents today:** the only reporters so far are the team's own agents. Nobody outside the team has used it yet.
