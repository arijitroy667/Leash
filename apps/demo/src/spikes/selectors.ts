import { createPublicClient, http, toFunctionSelector } from "viem";
import { sepolia } from "viem/chains";
const c = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
const check = async (name: string, addr: `0x${string}`, sigs: string[]) => {
  const code = (await c.getCode({ address: addr })) ?? "0x";
  console.log(name, "code bytes", (code.length - 2) / 2);
  for (const s of sigs) console.log(" ", code.includes(toFunctionSelector(s).slice(2)) ? "yes" : "NO ", s);
};
await check("registrar", "0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3", [
  "register(string,address,bytes32,address,address,uint64,address,bytes32)",
  "makeCommitment(string,address,bytes32,address,address,uint64,bytes32)",
  "commit(bytes32)", "getRegisterPrice(string,uint64,address)", "isAvailable(string)",
]);
await check("resolverImpl", "0x115eb53f0c60696633855f90b138178fb40b2b2c", [
  "initialize(address,uint256,bytes[])", "initialize((address,uint256)[],bytes[])",
  "setText(bytes,string,string)", "text(bytes32,string)", "grantSetterRoles(bytes,address)", "grantRootRoles(uint256,address)",
  "hasRoles(uint256,uint256,address)", "hasRootRoles(uint256,address)", "roles(uint256,address)", "multicall(bytes[])",
]);
await check("factory", "0xda70306c98e97ece36f997a21368e53298572991", ["deployProxy(address,uint256,bytes)"]);
await check("mockUSDC", "0x240b0316df57887dbbe58b586508b19e633a14aa", ["mint(address,uint256)", "approve(address,uint256)"]);
process.exit(0);
