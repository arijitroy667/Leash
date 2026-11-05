// Prints public addresses only: the Arkiv writer wallet behind each Hedera key. No secrets.
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";

const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
for (const n of ["AGENT_A", "AGENT_B", "AGENT_C", "PROBER"]) {
  const key = process.env[`${n}_KEY`];
  if (key) console.log(n, process.env[`${n}_ACCOUNT`], privateKeyToAccount(hex(key)).address);
}
