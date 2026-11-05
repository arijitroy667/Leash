// NFR-01: the latency Leash adds to a payment, measured on the real networks with dry runs. Nothing is paid and
// nothing is written. Cold is a fresh guard with empty caches; warm repeats the same check straight after.
//   tsx apps/demo/src/latency.ts [rounds]
import "./safe-exit.ts";
import "dotenv/config";
import { buildAgent } from "@leash/guard";

const rounds = Number(process.argv[2] ?? 5);
const targets = ["WEATHER", "LEMON"].map((k) => `${process.env[`MERCHANT_${k}_URL`]}/forecast`);
const env = { ...process.env, LEASH_DB: ":memory:", HCS_TOPIC_ID: "" }; // its own empty store, and no audit messages

async function challenge(url: string) {
  const res = await fetch(url);
  const header = res.headers.get("payment-required");
  if (res.status !== 402 || !header) throw new Error(`${url} did not ask for payment`);
  return JSON.parse(Buffer.from(header, "base64").toString()).accepts[0];
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(p * xs.length) - 1)]!;

const cold: number[] = [];
const warm: number[] = [];
for (const url of targets) {
  const requirements = await challenge(url);
  for (let i = 0; i < rounds; i++) {
    const { guard } = buildAgent("A", env);
    const first = await guard.check({ url, requirements });
    cold.push(first.latencyMs!);
    for (let j = 0; j < 5; j++) warm.push((await guard.check({ url, requirements })).latencyMs!);
    console.log(`${new URL(url).host}: cold ${first.latencyMs} ms, ${first.verdict} ${first.reasons.join(",") || "no flags"}`);
    guard.close();
  }
}
console.log(`warm: p50 ${pct(warm, 0.5)} ms, p95 ${pct(warm, 0.95)} ms over ${warm.length} decisions (target p95 under 800 ms)`);
console.log(`cold: p50 ${pct(cold, 0.5)} ms, p95 ${pct(cold, 0.95)} ms over ${cold.length} decisions (target under 3000 ms)`);
process.exit(0);
