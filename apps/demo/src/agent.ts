// Builds a real guarded agent from .env, and a small CLI for one paid call.
//   tsx apps/demo/src/agent.ts A https://merchant.example/forecast
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { buildAgent, LeashDenied, LeashEscalated, toMirrorTxId } from "@leash/guard";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , letter = "A", url] = process.argv;
  if (!url) throw new Error("usage: agent.ts <A|B|C> <url>");
  const { guard, paidFetch } = buildAgent(letter);
  try {
    const res = await paidFetch(url);
    const leash = (res as any).leash;
    console.log(`status ${res.status}`, leash ?? "");
    if (leash) console.log(`https://hashscan.io/testnet/transaction/${toMirrorTxId(leash.txId)}`);
    console.log((await res.text()).slice(0, 300));
  } catch (e) {
    if (e instanceof LeashDenied) console.log("DENIED", e.decision.reasons, `R=${e.decision.score.toFixed(1)}`, e.decision.standing);
    else if (e instanceof LeashEscalated) console.log("ESCALATED", e.decision.reasons, `R=${e.decision.score.toFixed(1)}`, "approval", e.approvalId);
    else throw e;
  }
  for (let i = 0; i < 30 && guard.store.outboxDepth().depth > 0; i++) {
    await guard.flush();
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("outbox depth", guard.store.outboxDepth().depth);
  process.exit(0);
}
