// Registers real ENSv2 names on Sepolia, deploys one Permissioned Resolver per merchant,
// sets herd.* records and grants key-scoped roles. Idempotent: rerun it after merchant URLs change.
import "dotenv/config";
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, http, keccak256, parseAbi, parseEventLogs, toBytes, zeroAddress, zeroHash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { packetToBytes } from "viem/ens";
import { bytesToHex } from "viem";

const REGISTRAR = "0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3" as const;
const MOCK_USDC = "0x240b0316df57887dbbe58b586508b19e633a14aa" as const; // ENS's own Sepolia fee token
const RESOLVER_IMPL = "0x115eb53f0c60696633855f90b138178fb40b2b2c" as const;
const FACTORY = "0xda70306c98e97ece36f997a21368e53298572991" as const;
const ROLE_SET_TEXT = 1n << 4n;
const ALL_ROLES = BigInt("0x" + "1".repeat(64));
const ONE_YEAR = 31536000n;

// Signatures checked against deployed bytecode (see src/spikes/selectors.ts). GitHub main differs.
const registrarAbi = parseAbi([
  "function isAvailable(string label) view returns (bool)",
  "function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)",
  "function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)",
]);
const erc20Abi = parseAbi(["function mint(address to, uint256 amount)", "function approve(address spender, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
]);
const resolverAbi = parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
  "function setText(bytes name, string key, string value)",
  "function grantSetterRoles(bytes setter, address account)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function multicall(bytes[] calls) returns (bytes[])",
]);

const env = process.env;
const need = (k: string) => {
  if (!env[k]) throw new Error(`${k} is missing from .env`);
  return env[k]!;
};
const hex = (k: string) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;

const account = privateKeyToAccount(hex(need("ENS_MANAGER_KEY")));
const transport = http(env.SEPOLIA_RPC_URL);
const pub = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account });
const sent = async (hash: `0x${string}`) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return r;
};
const save = (k: string, v: string) => {
  appendFileSync(".env", `\n${k}=${v}\n`);
  env[k] = v;
};

const merchants = [
  { id: "WEATHER", label: env.ENS_LABEL_WEATHER ?? "herd-weather", version: 0n, schema: "city,tempC,conditions", maxPrice: "0.25" },
  { id: "LEMON", label: env.ENS_LABEL_LEMON ?? "herd-lemon", version: 1n, schema: "city,tempC,conditions", maxPrice: "0.25" },
];

if (!env.LEMON_REBUTTAL_KEY) save("LEMON_REBUTTAL_KEY", generatePrivateKey());
const rebuttalHolder = privateKeyToAccount(hex(env.LEMON_REBUTTAL_KEY!)).address;

console.log(`manager ${account.address}, ${await pub.getBalance({ address: account.address })} wei`);

// Fee token: ENS's Sepolia registrar charges in its public test token.
const bal = await pub.readContract({ address: MOCK_USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
if (bal < 100_000_000n) {
  await sent(await wallet.writeContract({ address: MOCK_USDC, abi: erc20Abi, functionName: "mint", args: [account.address, 100_000_000n] }));
  console.log("minted ENS test fee token");
}

for (const m of merchants) {
  const name = `${m.label}.eth`;
  const dns = bytesToHex(packetToBytes(name));

  // 1. Resolver, one per merchant, because a resolver role covers every name it serves.
  let resolver = env[`ENS_RESOLVER_${m.id}`] as `0x${string}` | undefined;
  if (!resolver) {
    const salt = BigInt(keccak256(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [keccak256(toBytes("OwnedResolver")), account.address, m.version],
    )));
    const data = encodeFunctionData({ abi: resolverAbi, functionName: "initialize", args: [[{ account: account.address, roleBitmap: ALL_ROLES }], []] });
    const r = await sent(await wallet.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "deployProxy", args: [RESOLVER_IMPL, salt, data] }));
    resolver = parseEventLogs({ abi: factoryAbi, logs: r.logs, eventName: "ProxyDeployed" })[0]!.args.proxyAddress;
    save(`ENS_RESOLVER_${m.id}`, resolver);
    console.log(`${m.id} resolver ${resolver}`);
  }

  // 2. Name, by commit and reveal.
  const available = await pub.readContract({ address: REGISTRAR, abi: registrarAbi, functionName: "isAvailable", args: [m.label] });
  if (available) {
    const secret = `0x${randomBytes(32).toString("hex")}` as const;
    const commitment = await pub.readContract({
      address: REGISTRAR, abi: registrarAbi, functionName: "makeCommitment",
      args: [m.label, account.address, secret, zeroAddress, resolver, ONE_YEAR, zeroHash],
    });
    await sent(await wallet.writeContract({ address: REGISTRAR, abi: registrarAbi, functionName: "commit", args: [commitment] }));
    console.log(`${name} committed, waiting 65 s`);
    await new Promise((r) => setTimeout(r, 65_000));
    const [base, premium] = await pub.readContract({ address: REGISTRAR, abi: registrarAbi, functionName: "getRegisterPrice", args: [m.label, ONE_YEAR, MOCK_USDC] });
    await sent(await wallet.writeContract({ address: MOCK_USDC, abi: erc20Abi, functionName: "approve", args: [REGISTRAR, base + premium] }));
    const r = await sent(await wallet.writeContract({
      address: REGISTRAR, abi: registrarAbi, functionName: "register",
      args: [m.label, account.address, secret, zeroAddress, resolver, ONE_YEAR, MOCK_USDC, zeroHash],
    }));
    console.log(`${name} registered in ${r.transactionHash}`);
  } else console.log(`${name} already registered`);
  if (!env[`ENS_NAME_${m.id}`]) save(`ENS_NAME_${m.id}`, name);

  // 3. Records.
  const origin = env[`MERCHANT_${m.id}_URL`];
  const records: Record<string, string> = {
    "herd.payTo": need(`MERCHANT_${m.id}_ACCOUNT`),
    "herd.network": env.HEDERA_NETWORK ?? "hedera:testnet",
    "herd.asset": env.HEDERA_USDC ?? "0.0.429274",
    "herd.maxPrice": m.maxPrice,
    "herd.schema": m.schema,
    "herd.policyVersion": String(Math.floor(Date.now() / 1000)),
  };
  if (origin) {
    records["herd.domains"] = origin;
    records["herd.probeUrl"] = `${origin}/forecast`;
  } else console.log(`  MERCHANT_${m.id}_URL not set yet: herd.domains left empty, rerun after deploying merchants`);
  const calls = Object.entries(records).map(([key, value]) => encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [dns, key, value] }));
  await sent(await wallet.writeContract({ address: resolver, abi: resolverAbi, functionName: "multicall", args: [calls] }));
  console.log(`  ${name}: ${Object.keys(records).length} records set`);

  // 4. Key-scoped role: this wallet can write herd.rebuttal and nothing else.
  const resource = BigInt(keccak256(toBytes("herd.rebuttal")));
  const held = await pub.readContract({ address: resolver, abi: resolverAbi, functionName: "hasRoles", args: [resource, ROLE_SET_TEXT, rebuttalHolder] });
  if (!held) {
    const setter = encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: ["0x", "herd.rebuttal", ""] });
    await sent(await wallet.writeContract({ address: resolver, abi: resolverAbi, functionName: "grantSetterRoles", args: [setter, rebuttalHolder] }));
  }
  const after = await pub.readContract({ address: resolver, abi: resolverAbi, functionName: "hasRoles", args: [resource, ROLE_SET_TEXT, rebuttalHolder] });
  console.log(`  rebuttal role for ${rebuttalHolder}: ${after}`);
}

console.log("\nENS ready. Fund the rebuttal holder with a little Sepolia ETH only if it must write records itself.");
process.exit(0);
