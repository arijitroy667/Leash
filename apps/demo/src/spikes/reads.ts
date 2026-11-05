// Spike: live, keyless reads of ENSv2 on Sepolia and Arkiv on rabdi.
import { createPublicClient as arkivClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import { namehash, normalize } from "viem/ens";

const sep = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com") });
console.log("sepolia block", await sep.getBlockNumber());
for (const name of ["nick.eth", "test.eth"]) {
  const addr = await sep.getEnsAddress({ name: normalize(name) }).catch((e) => `error ${String(e).slice(0, 100)}`);
  console.log(name, "addr", addr, namehash(name).slice(0, 10));
}
const REGISTRAR = "0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3" as const;
const code = await sep.getCode({ address: REGISTRAR });
console.log("ETHRegistrar code bytes:", code ? (code.length - 2) / 2 : 0);
const avail = await sep.readContract({ address: REGISTRAR, abi: parseAbi(["function isAvailable(string) view returns (bool)"]), functionName: "isAvailable", args: ["leash-weather"] }).catch((e) => `error ${String(e).slice(0, 160)}`);
console.log("leash-weather available:", avail);

const ark = arkivClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });
console.log("arkiv block", await ark.getBlockNumber());
process.exit(0);
