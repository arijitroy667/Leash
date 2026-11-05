// Rehearsal only, never in the demo: signs pending approvals with REHEARSAL_OWNER_KEY so the block path can be
// tested unattended. The signature is real and goes through the same checks. LEASH_OWNER_ADDRESS must match it.
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { Store, approvalMessage } from "@leash/guard";

const owner = privateKeyToAccount(process.env.REHEARSAL_OWNER_KEY as `0x${string}`);
const store = new Store(process.env.LEASH_DB ?? ".leash/leash.sqlite");
console.log(`rehearsal approver ${owner.address}`);
for (;;) {
  store.expireApprovals(Date.now() / 1000);
  for (const a of store.listApprovals("pending")) {
    store.resolveApproval(a.id, "approved", await owner.signMessage({ message: approvalMessage(a) }));
    console.log(`approved ${a.id} ${a.card.merchant} ${a.card.amountUsd}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}
