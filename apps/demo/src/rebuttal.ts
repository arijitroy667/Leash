// Files a real signed rebuttal. Usage: tsx apps/demo/src/rebuttal.ts <role|norole> [reason] [evidence url or hash]
// "norole" signs with a fresh wallet holding no ENS role, to show the check rejects it.
import "dotenv/config";
import { bytesToHex, createWalletClient, http, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { normalize, packetToBytes } from "viem/ens";
import { REBUTTAL_REASONS, digest, holdsRebuttalRole, rebuttalMessage, safeError } from "@leash/guard";
import { buildReader } from "./prober.ts";

const env = process.env;
const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
const [, , who = "role", reason = "config-error", evidence = ""] = process.argv;
if (!REBUTTAL_REASONS.includes(reason as never)) throw new Error(`reason must be one of ${REBUTTAL_REASONS.join(", ")}`);

const reader = buildReader();
const ens = env.ENS_NAME_LEMON!;
const decl = await reader.ens.fetch(ens);
if (!decl) throw new Error(`${ens} has no declaration`);
const signer = privateKeyToAccount(who === "role" ? hex(env.LEMON_REBUTTAL_KEY!) : generatePrivateKey());

const now = Date.now() / 1000;
const { view } = await reader.read(decl.payTo, now);
const filedAt = Math.floor(now);
const fields = { ens, payee: decl.payTo, reason, evidenceHash: digest(evidence || `${reason}:${filedAt}`), filedAt };
const signature = await signer.signMessage({ message: rebuttalMessage({ ns: reader.ns, ...fields }) });

const resolver = await reader.client.getEnsResolver({ name: normalize(ens) });
const allowed = await holdsRebuttalRole(reader.client, resolver, signer.address);
console.log(`signer ${signer.address} holds the leash.rebuttal role: ${allowed}`);
if (!allowed) {
  console.log("REJECTED: this wallet holds no role on the merchant's resolver. Nothing was filed.");
  process.exit(0);
}
if (view.standing !== "BLOCKED") console.log(`note: merchant is ${view.standing}; a rebuttal only matters while BLOCKED`);
if (view.rebuttalUsed) console.log("note: this block episode already used its one rebuttal");

const { entityKey } = await reader.arkiv.writeRebuttal(hex(env.PROBER_KEY!), {
  ...fields, signer: signer.address, signature, episodeStart: view.blockStart ?? 0,
}, reader.params.reportTtlSec);
console.log(`rebuttal filed: ${entityKey}`);
reader.audit("rebuttal", entityKey, { payee: decl.payTo, ens, reason, signer: signer.address, entityKey, at: filedAt });
await reader.flushAudit();

// The role lets this wallet publish the entity key on its one ENS key. Not awaited: a Sepolia block takes longer
// than a scene can wait, and the rebuttal is already valid without it.
try {
  const hash = await createWalletClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL), account: signer }).writeContract({
    address: resolver, abi: parseAbi(["function setText(bytes name, string key, string value)"]), functionName: "setText",
    args: [bytesToHex(packetToBytes(ens)), "leash.rebuttal", entityKey],
  });
  console.log(`leash.rebuttal record sent by the role holder: https://sepolia.etherscan.io/tx/${hash}`);
} catch (e) {
  console.log(`leash.rebuttal record not written: ${safeError(e)}`);
}
process.exit(0);
