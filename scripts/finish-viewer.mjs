import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const KEY = JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey;
const D = JSON.parse(readFileSync("scripts/backpack-sepolia.json", "utf8"));
const art = (p, n) => JSON.parse(readFileSync(`packages/contracts/out/${p}/${n}.json`, "utf8"));
const FACTORY_ADDR = "0x3147b4e9dc457857eaec4b7e5dade216bf2b0573";
const account = privateKeyToAccount(KEY);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const F = art("KeelBackpackFactory.sol", "KeelBackpackFactory");
const BACKPACK = art("KeelBackpack721.sol", "KeelBackpack721");
const BAYC = art("KeelBaycEndToEnd.t.sol", "BaycStandIn");

// Explicit gas, no estimation: with a thin balance the node's allowance check
// rejects the estimate even though the call itself is fine.
const fees = async () => {
  const base = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas;
  return { maxFeePerGas: (base * 112n) / 100n, maxPriorityFeePerGas: 50_000_000n };
};
const send = async (label, req, gas) => {
  const hash = await wallet.writeContract({ ...req, gas, ...(await fees()) });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== "success") throw new Error(`${label} reverted`);
  console.log(`  ${label.padEnd(22)} ${r.gasUsed} gas`);
  return r;
};

console.log(`balance ${formatEther(await pub.getBalance({ address: account.address }))} ETH\n`);
const backpack = await pub.readContract({ address: FACTORY_ADDR, abi: F.abi, functionName: "predictBackpack", args: [D.bayc] });
if (!(await pub.readContract({ address: FACTORY_ADDR, abi: F.abi, functionName: "isInitialized", args: [D.bayc] }))) {
  await send("init backpack", { address: FACTORY_ADDR, abi: F.abi, functionName: "init", args: [D.bayc] }, 3_000_000n);
}
const holder = await pub.readContract({ address: D.bayc, abi: BAYC.abi, functionName: "ownerOf", args: [1n] });
if (holder.toLowerCase() !== account.address.toLowerCase() && holder.toLowerCase() !== backpack.toLowerCase()) {
  await send("withdraw old", { address: holder, abi: BACKPACK.abi, functionName: "withdraw", args: [1n] }, 150_000n);
}
if ((await pub.readContract({ address: D.bayc, abi: BAYC.abi, functionName: "ownerOf", args: [1n] })).toLowerCase() !== backpack.toLowerCase()) {
  await send("wrap ape #1", { address: D.bayc, abi: BAYC.abi, functionName: "safeTransferFrom", args: [account.address, backpack, 1n] }, 220_000n);
}
const json = await pub.readContract({ address: backpack, abi: BACKPACK.abi, functionName: "tokenJSON", args: [1n] });
const anim = /"animation_url":"([^"]{0,45})/.exec(json);
console.log(`\n  NFT       ${backpack}`);
console.log(`  animation ${anim ? anim[1] : "(none)"}…`);
console.log(`  json len  ${json.length}`);
console.log(`\nleft ${formatEther(await pub.getBalance({ address: account.address }))} ETH`);
writeFileSync("scripts/backpack-sepolia.json", JSON.stringify({ ...D, factory: FACTORY_ADDR, backpack }, null, 2));
