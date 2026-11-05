// Runs the demo scenes on real networks. No scene is scripted past a chain event: each step waits for
// what it needs to be visible on Hedera and Arkiv, never for a fixed time.
//   tsx apps/demo/src/show.ts 1        one scene
//   tsx apps/demo/src/show.ts all      scenes in order
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { probeOnce } from "./prober.ts";
import { buildAgent, buildReader, HerdDenied, HerdEscalated, toMirrorTxId } from "@herd/guard";

const env = process.env;
const url = (k: string, path = "/forecast") => {
  const base = env[`MERCHANT_${k}_URL`];
  if (!base) throw new Error(`MERCHANT_${k}_URL is missing. Deploy the merchants first`);
  return `${base}${path}`;
};
const log = (s: string) => console.log(`\n=== ${s}`);
const reader = buildReader({ ...env, ARKIV_RPC_URL: undefined });

type Agent = ReturnType<typeof buildAgent>;
const agents: Record<string, Agent> = {};
// Rehearsal only: SHOW_AGENTS=A:F1,B:F2 stands in the aged funder accounts before the agents turn 24 hours old.
const stand = Object.fromEntries((env.SHOW_AGENTS ?? "").split(",").filter(Boolean).map((p) => p.split(":") as [string, string]));
const agent = (l: string) => (agents[l] ??= buildAgent(stand[l] ?? l));

interface Outcome { kind: "paid" | "denied" | "escalated"; approvalId?: string; txId?: string }

async function pay(l: string, target: string): Promise<Outcome> {
  const a = agent(l);
  try {
    let res = await a.paidFetch(target);
    // A serverless cold start can answer 5xx before any 402. No payment exists yet, so a retry is safe.
    for (let i = 0; i < 3 && res.status >= 500 && !(res as any).herd; i++) {
      console.log(`  merchant answered ${res.status} with no payment made, retrying`);
      await new Promise((r) => setTimeout(r, 2000));
      res = await a.paidFetch(target);
    }
    const herd = (res as any).herd;
    const d = herd && a.guard.explain(herd.decisionId);
    console.log(`  agent ${l}: PAID ${res.status}, delivered ${herd?.delivered}, R ${d?.score?.toFixed(1)} ${d?.standing}`);
    if (herd) console.log(`  https://hashscan.io/testnet/transaction/${toMirrorTxId(herd.txId)}`);
    return { kind: "paid", txId: herd?.txId };
  } catch (e) {
    if (e instanceof HerdDenied) {
      console.log(`  agent ${l}: DENY ${e.decision.reasons.join(",")} R ${e.decision.score.toFixed(1)} ${e.decision.standing}`);
      return { kind: "denied" };
    }
    if (e instanceof HerdEscalated) {
      console.log(`  agent ${l}: ESCALATE ${e.decision.reasons.join(",")} R ${e.decision.score.toFixed(1)} ${e.decision.standing}, approval ${e.approvalId}`);
      return { kind: "escalated", approvalId: e.approvalId };
    }
    throw e;
  }
}

/** Pays, and when escalated waits for the owner to sign in the console. */
async function payWithApproval(l: string, target: string): Promise<Outcome> {
  const first = await pay(l, target);
  if (first.kind !== "escalated") return first;
  console.log("  waiting for the owner to sign in the console...");
  const status = await agent(l).guard.waitForApproval(first.approvalId!, 115_000);
  console.log(`  owner: ${status}`);
  return status === "approved" ? pay(l, target) : first;
}

async function flushAll() {
  for (let i = 0; i < 40; i++) {
    for (const a of Object.values(agents)) await a.guard.flush();
    if (Object.values(agents).every((a) => a.guard.store.outboxDepth().depth === 0)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log("  outbox still draining");
}

async function standing(name: string) {
  const decl = await reader.ens.fetch(name);
  const { view, rows } = await reader.read(decl!.payTo, Date.now() / 1000);
  const end = view.blockEnd ? `, ends in ${Math.round(view.blockEnd - Date.now() / 1000)} s` : "";
  console.log(`  ${name}: ${view.standing}, strikes ${view.strikes}, valid reports ${rows.reports.filter((r) => r.valid).length}, rebuttal used ${view.rebuttalUsed}${end}`);
  return view;
}

async function waitFor(name: string, want: string, timeoutMs = 200_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await standing(name);
    if (v.standing === want) return v;
    if (Date.now() > end) throw new Error(`${name} never reached ${want}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const LEMON = () => env.ENS_NAME_LEMON!;
const run = (args: string[]) => new Promise<void>((done) => {
  const p = spawn(process.execPath, ["--import", "tsx", ...args], { stdio: ["ignore", "inherit", "pipe"], env: { ...process.env, ARKIV_RPC_URL: "" } });
  let err = "";
  p.stderr!.on("data", (d) => (err += d));
  p.on("exit", (code) => {
    if (code) throw new Error(`${args[0]} failed: ${err.slice(-600)}`);
    done();
  });
});
let relay: ChildProcess | undefined;
if (env.SHOW_RELAY) {
  relay = spawn(process.execPath, ["--import", "tsx", "apps/demo/src/outage-relay.ts"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 4000));
}
const scenes: Record<string, () => Promise<void>> = {
  async 1() {
    log("Scene 1: happy path. Agent A buys from weather with no human");
    await pay("A", url("WEATHER"));
    await flushAll();
    await standing(env.ENS_NAME_WEATHER!);
  },
  async 2() {
    log("Scene 2: the herd learns. A is cheated, B escalates and is cheated, C is protected");
    await pay("A", url("LEMON"));
    await flushAll();
    await standing(LEMON());
    await payWithApproval("B", url("LEMON"));
    await flushAll();
    await waitFor(LEMON(), "BLOCKED");
    await pay("C", url("LEMON"));
  },
  async 3() {
    log("Scene 3: spoof. A 402 claims the weather name with a different payTo");
    await pay("A", url("SPOOF"));
  },
  async 4() {
    log("Scene 4: unknown merchant. Owner signs once; the approval cannot be reused");
    await payWithApproval("C", url("ROGUE"));
    await flushAll();
    console.log("  same challenge again:");
    await pay("C", url("ROGUE"));
  },
  async 5() {
    log("Scene 5: block expires on its own, then probation");
    await waitFor(LEMON(), "PROBATION");
    const a = agent("A");
    const probe = await fetch(url("LEMON", "/premium"));
    const reqs = JSON.parse(Buffer.from(probe.headers.get("payment-required")!, "base64").toString()).accepts[0];
    const d = await a.guard.check({ url: url("LEMON", "/premium"), requirements: reqs });
    console.log(`  0.03 USD dry run: ${d.verdict} R ${d.score.toFixed(1)} ${d.reasons.join(",")}`);
  },
  async "5a"() {
    log("Scene 5a: rebuttal. No role is rejected; the role holder signs; the real probe still gets junk");
    await run(["apps/demo/src/rebuttal.ts", "norole"]);
    await run(["apps/demo/src/rebuttal.ts", "role"]);
    console.log("  probe:", JSON.stringify(await probeOnce(reader, LEMON())));
    await standing(LEMON());
  },
  async 6() {
    log("Scene 6: scam loop. A new purchase cheats A: hold. B is approved and cheated: block, strike 2");
    await pay("A", url("LEMON", "/hourly"));
    await flushAll();
    await standing(LEMON());
    await payWithApproval("B", url("LEMON", "/hourly"));
    await flushAll();
    await waitFor(LEMON(), "BLOCKED", 60_000);
  },
  async 7() {
    log("Scene 7: replay, then a real Arkiv outage");
    const before = await pay("A", url("WEATHER", "/hourly"));
    if (before.kind === "paid") {
      console.log("  same challenge again:");
      await pay("A", url("WEATHER", "/hourly"));
    }
    await flushAll();
    await pay("C", url("LEMON", "/premium")); // caches the block
    if (!relay) throw new Error("run with ARKIV_RPC_URL pointing at the relay and SHOW_RELAY=1");
    relay.kill();
    console.log("  relay stopped: Arkiv is really unreachable for the guards");
    await new Promise((r) => setTimeout(r, 6000)); // past the fresh window
    await pay("C", url("LEMON", "/premium"));
    console.log("  a guard on a fresh machine, with no cache:");
    const fresh = buildAgent(stand.C ?? "C", { ...env, HERD_DB: ":memory:" });
    agents.fresh = fresh;
    try {
      await fresh.paidFetch(url("WEATHER", "/premium"));
    } catch (e) {
      if (e instanceof HerdEscalated) console.log(`  fresh guard: ESCALATE ${e.decision.reasons.join(",")}`);
      else if (e instanceof HerdDenied) console.log(`  fresh guard: DENY ${e.decision.reasons.join(",")}`);
      else throw e;
    }
  },
  async 8() {
    log("Scene 8: an MCP client pays through the server. It can only wait; only the owner can approve");
    const mcp = new Client({ name: "demo-client", version: "1.0.0" });
    await mcp.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "packages/mcp/src/server.ts"],
      env: { ...process.env, HERD_MCP_AGENT: stand.C ?? "C" } as Record<string, string>,
      stderr: "ignore",
    }));
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    console.log("  tools:", tools.join(", "));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await mcp.callTool({ name, arguments: args });
      return JSON.parse(r.content[0].text);
    };
    const target = url("ROGUE", "/premium");
    const first = await call("herd_pay_request", { url: target, maxUsd: 0.05 });
    console.log("  herd_pay_request:", JSON.stringify({ status: first.status, reasons: first.reasons, standing: first.standing }));
    if (first.status === "pending_approval") {
      const waited = await call("herd_await_approval", { approvalId: first.approvalId, timeoutMs: 115000 });
      console.log("  herd_await_approval:", waited.status);
      if (waited.status === "approved") {
        const paid = await call("herd_pay_request", { url: target, maxUsd: 0.05 });
        console.log("  herd_pay_request:", JSON.stringify({ status: paid.status, txId: paid.txId, delivered: paid.delivered, untrusted: paid.untrusted }));
      }
    }
    console.log("  budget:", JSON.stringify(await call("herd_get_budget", {})));
    await mcp.close();
  },
};

// Warm every merchant first, so a cold start cannot land in the middle of a scene.
for (const k of ["WEATHER", "LEMON", "SPOOF", "ROGUE"]) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url(k)).catch(() => null);
    if (r?.status === 402) break;
    await new Promise((d) => setTimeout(d, 2000));
  }
}

const which = process.argv[2] ?? "all";
for (const key of which === "all" ? Object.keys(scenes) : which.split(",")) {
  const s = scenes[key];
  if (!s) throw new Error(`no scene ${key}`);
  await s();
}
relay?.kill();
process.exit(0);
