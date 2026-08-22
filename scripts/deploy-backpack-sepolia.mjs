// Deploys the Keel backpack wrapper stack to Sepolia.
//
// Deploy order matters and is not cosmetic: the factory and the ledger reference
// each other, and both hold the other as an immutable so `init` can stay
// parameterless (which is what keeps a backpack's canonical address
// unsquattable). So the ledger's address is predicted from the deployer nonce,
// handed to the factory, and then the ledger is deployed into it. The script
// asserts the prediction held rather than trusting it.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getContractAddress, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = process.env.OCA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

// The key comes from the deployer file this repo already uses, or from
// OCA_DEPLOYER_PRIVATE_KEY when it is actually populated. It is read here and
// nowhere else: nothing logs, echoes or returns it.
const KEY_FILE = process.env.KEEL_DEPLOYER_FILE ?? ".secrets/vault-sepolia-deployer.json";
const KEY = process.env.OCA_DEPLOYER_PRIVATE_KEY || JSON.parse(readFileSync(KEY_FILE, "utf8")).privateKey;
if (!KEY) {
  console.error(`no deployer key: set OCA_DEPLOYER_PRIVATE_KEY or provide ${KEY_FILE}`);
  process.exit(1);
}

const artifact = (name) =>
  JSON.parse(readFileSync(`packages/contracts/out/${name}.sol/${name}.json`, "utf8"));

const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`);
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

const deploy = async (name, args = []) => {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet.deployContract({ abi, bytecode: bytecode.object, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${name} deployment reverted`);
  console.log(`  ${name.padEnd(34)} ${receipt.contractAddress}  (${receipt.gasUsed} gas)`);
  return receipt.contractAddress;
};

const balanceBefore = await publicClient.getBalance({ address: account.address });
console.log(`deployer ${account.address}`);
console.log(`balance  ${formatEther(balanceBefore)} ETH`);
console.log(`gas      ${Number(await publicClient.getGasPrice()) / 1e9} gwei\n`);

// The forwarder and admin for the DON-fed registries. The forwarder is
// admin-mutable until locked, so the deployer stands in until the real
// KeystoneForwarder is wired.
const FORWARDER = account.address;

const keelHold = await deploy("KeelHold");
const attestations = await deploy("KeelUriAttestationRegistry", [FORWARDER, account.address]);
const commitments = await deploy("KeelCreatorCommitmentRegistry");

const nonce = await publicClient.getTransactionCount({ address: account.address });
// The factory is next, so the ledger lands one nonce later.
const predictedLedger = getContractAddress({ from: account.address, nonce: BigInt(nonce + 1) });
const factory = await deploy("KeelBackpackFactory", [predictedLedger]);
const ledger = await deploy("KeelBackpackProofLedger", [
  factory,
  keelHold,
  attestations,
  commitments,
]);
if (ledger.toLowerCase() !== predictedLedger.toLowerCase()) {
  throw new Error(`ledger landed at ${ledger}, factory was told ${predictedLedger}`);
}
const bounty = await deploy("KeelPreservationBounty", [ledger]);

const balanceAfter = await publicClient.getBalance({ address: account.address });
console.log(`\nspent    ${formatEther(balanceBefore - balanceAfter)} ETH`);
console.log(`left     ${formatEther(balanceAfter)} ETH`);
console.log(
  `\n${JSON.stringify(
    { chainId: sepolia.id, keelHold, attestations, commitments, factory, ledger, bounty },
    null,
    2,
  )}`,
);
