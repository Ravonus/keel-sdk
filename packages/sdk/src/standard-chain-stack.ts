export const KEEL_STANDARD_CHAIN_STACK = [
  {
    key: "keelGraphRegistry",
    contractName: "KeelGraphRegistry",
    chainContractKind: "keel-graph-registry",
    label: "KEEL Graph Registry",
    dependencies: [],
    operatorArguments: 0,
  },
  {
    key: "keelLibraryRegistry",
    contractName: "KeelLibraryRegistry",
    chainContractKind: "keel-library-registry",
    label: "KEEL Library Registry",
    dependencies: ["keelGraphRegistry"],
    operatorArguments: 0,
  },
  {
    key: "keelAssetTagRegistry",
    contractName: "KeelAssetTagRegistry",
    chainContractKind: "keel-asset-tag-registry",
    label: "KEEL Asset Tag Registry",
    dependencies: ["keelLibraryRegistry"],
    operatorArguments: 0,
  },
  {
    key: "keelModuleReviewRegistry",
    contractName: "KeelModuleReviewRegistry",
    chainContractKind: "keel-module-review-registry",
    label: "KEEL Module Review Registry",
    dependencies: ["keelGraphRegistry"],
    operatorArguments: 2,
  },
  {
    key: "keelPluginRegistry",
    contractName: "KeelPluginRegistry",
    chainContractKind: "keel-plugin-registry",
    label: "KEEL Plugin Registry",
    dependencies: ["keelGraphRegistry"],
    operatorArguments: 2,
  },
] as const;

/** Foundational browser modules copied into each chain's Library during the
 * explicit standard bootstrap step. Contract deployment alone never pretends
 * that these bytes were published. */
export const KEEL_STANDARD_LIBRARY_ASSET_IDS = ["p5-1-11-3", "seeded-random"] as const;

export type KeelStandardChainContract = (typeof KEEL_STANDARD_CHAIN_STACK)[number];
export type KeelStandardChainContractKey = KeelStandardChainContract["key"];
export type KeelStandardChainContractKind = KeelStandardChainContract["chainContractKind"];
export type KeelStandardChainAddresses = Readonly<Record<KeelStandardChainContractKey, string>>;

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/iu;

function requireAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new Error(`KEEL standard chain deployment is missing a valid ${label}.`);
  }
  return value;
}

export function resolveKeelStandardChainConstructorArgs(input: {
  readonly contract: KeelStandardChainContract;
  readonly operator: string;
  readonly addresses: Readonly<Partial<Record<KeelStandardChainContractKey, string>>>;
}): readonly string[] {
  const operator = requireAddress(input.operator, "operator");
  const dependencies = input.contract.dependencies.map((key) => requireAddress(input.addresses[key], key));
  return [...Array.from({ length: input.contract.operatorArguments }, () => operator), ...dependencies];
}

export function buildKeelStandardChainDeploymentPlan(input: {
  readonly operator: string;
  readonly addresses: KeelStandardChainAddresses;
}): readonly (KeelStandardChainContract & { readonly args: readonly string[] })[] {
  return KEEL_STANDARD_CHAIN_STACK.map((contract) => ({
    ...contract,
    args: resolveKeelStandardChainConstructorArgs({ contract, ...input }),
  }));
}

export function assertKeelStandardChainDeployment(
  value: Readonly<Partial<Record<KeelStandardChainContractKey, unknown>>>,
): KeelStandardChainAddresses {
  return Object.fromEntries(
    KEEL_STANDARD_CHAIN_STACK.map(({ key }) => [key, requireAddress(value[key], key)]),
  ) as unknown as KeelStandardChainAddresses;
}
