// Files a real signed rebuttal. Usage: tsx apps/demo/src/rebuttal.ts <role|norole> [reason]
// "norole" signs with a fresh wallet holding no ENS role, to show the check rejects it.
import "dotenv/config";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { normalize } from "viem/ens";
import { REBUTTAL_REASONS, digest, holdsRebuttalRole, rebuttalMessage } from "@herd/guard";
import { buildReader } from "./prober.ts";

const env = process.env;
const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
const [, , who = "role", reason = "config-error"] = process.argv;
if (!REBUTTAL_REASONS.includes(reason as never)) throw new Error(`reason must be one of ${REBUTTAL_REASONS.join(", ")}`);

const reader = buildReader();
const ens = env.ENS_NAME_LEMON!;
const decl = await reader.ens.fetch(ens);
if (!decl) throw new Error(`${ens} has no declaration`);
const signer = privateKeyToAccount(who === "role" ? hex(env.LEMON_REBUTTAL_KEY!) : generatePrivateKey());

const now = Date.now() / 1000;
const { view } = await reader.read(decl.payTo, now);
const filedAt = Math.floor(now);
const fields = { ens, payee: decl.payTo, reason, evidenceHash: digest(`${reason}:${filedAt}`), filedAt };
const signature = await signer.signMessage({ message: rebuttalMessage({ ns: reader.ns, ...fields }) });

const resolver = await reader.client.getEnsResolver({ name: normalize(ens) });
const allowed = await holdsRebuttalRole(reader.client, resolver, signer.address);
console.log(`signer ${signer.address} holds the herd.rebuttal role: ${allowed}`);
if (!allowed) {
  console.log("REJECTED: this wallet holds no role on the merchant's resolver. Nothing was filed.");
  process.exit(0);
}
if (view.standing !== "BLOCKED") console.log(`note: merchant is ${view.standing}; a rebuttal only matters while BLOCKED`);
if (view.rebuttalUsed) console.log("note: this block episode already used its one rebuttal");

const { entityKey } = await reader.arkiv.writeRebuttal(hex(env.PROBER_KEY!), {
  ...fields, signer: signer.address, signature, episodeStart: view.blockEnd ?? 0,
}, reader.params.reportTtlSec);
console.log(`rebuttal filed: ${entityKey}`);
process.exit(0);
