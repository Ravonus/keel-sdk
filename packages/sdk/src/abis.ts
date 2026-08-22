import { ABI_CONTRACTS, ABI_LOADERS } from "./abis.generated.js";

export { ABI_CONTRACTS };
import { getModule, resolveModuleTarget, type ModuleTargetQuery } from "./modules.js";
import type { KeelUnitId } from "./modules.generated.js";

/**
 * ABIs are recorded per module and loaded on demand. Together they run to about
 * a megabyte, so they are deliberately not part of the registry every consumer
 * imports — asking for one contract pulls in only its module's chunk.
 *
 * Nothing here reaches the network or the repository, so a module works exactly
 * the same whether its source repository is public or private.
 */

export type ContractAbi = readonly unknown[];

/** Contracts of a unit that have a recorded ABI. */
export function moduleAbiContracts(module: KeelUnitId): readonly string[] {
  return ABI_CONTRACTS[module] ?? [];
}

export async function moduleAbi(module: KeelUnitId, contract: string): Promise<ContractAbi> {
  const load = ABI_LOADERS[module];
  if (!load) {
    getModule(module); // throws with a better message when the id is wrong
    throw new Error(`no ABIs recorded for ${module} — run \`pnpm keel sync\``);
  }
  const { ABIS } = await load();
  const abi = ABIS[contract];
  if (!abi) {
    throw new Error(
      `${module} has no ABI for ${contract}; recorded: ${moduleAbiContracts(module).join(", ") || "none"}`,
    );
  }
  return abi as ContractAbi;
}

export interface ModuleContract {
  readonly module: KeelUnitId;
  readonly contract: string;
  readonly chainId: number;
  readonly instance: string;
  readonly address: `0x${string}`;
  readonly abi: ContractAbi;
}

/**
 * Everything needed to call a deployed contract: its address on the chain and
 * its ABI. Pass the result straight to viem's getContract, ethers, or wagmi.
 */
export async function moduleContract(query: ModuleTargetQuery & { contract: string }): Promise<ModuleContract> {
  const target = resolveModuleTarget(query);
  const abi = await moduleAbi(query.module, query.contract);
  return {
    module: target.module,
    contract: target.contract,
    chainId: target.chainId,
    instance: target.instance,
    address: target.address,
    abi,
  };
}
