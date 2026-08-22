import {
  KEEL_APPS,
  KEEL_DEPLOYMENTS,
  KEEL_MODULES,
  type KeelAppId,
  type KeelDeployment,
  type KeelModule,
  type KeelModuleId,
  type KeelUnitId,
} from "./modules.generated.js";

export { KEEL_APPS, KEEL_DEPLOYMENTS, KEEL_MODULES };
export type { KeelAppId, KeelDeployment, KeelModule, KeelModuleId, KeelUnitId };

const BY_ID = new Map<string, KeelModule>([...KEEL_MODULES, ...KEEL_APPS].map((m) => [m.id, m]));

/** Reusable infrastructure only. Apps are deliberately excluded — see listApps. */
export function listModules(): readonly KeelModule[] {
  return KEEL_MODULES;
}

/**
 * Products built on the modules. They have addresses worth resolving, but they
 * are not published libraries and nothing in the protocol may depend on them.
 */
export function listApps(): readonly KeelModule[] {
  return KEEL_APPS;
}

/** Resolves a module or an app by id. */
export function getModule(id: KeelUnitId): KeelModule {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown module: ${id}`);
  return found;
}

/**
 * The module's dependencies, transitively, in the order they must be deployed —
 * dependencies first. Deploying a module means deploying this list, then itself.
 */
export function moduleDependencyOrder(id: KeelUnitId): readonly KeelUnitId[] {
  const order: KeelUnitId[] = [];
  const seen = new Set<KeelUnitId>();
  const visit = (current: KeelUnitId): void => {
    if (seen.has(current)) return;
    seen.add(current);
    for (const dep of getModule(current).deps) visit(dep);
    order.push(current);
  };
  visit(id);
  return order.filter((value) => value !== id);
}

/** Chain ids this module is known to be deployed on. */
export function moduleChains(id: KeelUnitId): readonly number[] {
  return [...new Set(KEEL_DEPLOYMENTS.filter((d) => d.module === id).map((d) => d.chainId))].sort((a, b) => a - b);
}

export interface ModuleTargetQuery {
  readonly module: KeelUnitId;
  readonly chainId: number;
  /** Omit to match any contract in the module. */
  readonly contract?: string;
  /** Omit to match any named instance; required when a chain carries several. */
  readonly instance?: string;
}

export function findDeployments(query: ModuleTargetQuery): readonly KeelDeployment[] {
  return KEEL_DEPLOYMENTS.filter(
    (d) =>
      d.module === query.module &&
      d.chainId === query.chainId &&
      (query.contract === undefined || d.contract === query.contract) &&
      (query.instance === undefined || d.instance === query.instance),
  );
}

/**
 * Resolves exactly one deployment, or throws. An ambiguous match is an error
 * rather than a silent first-hit: a chain really can carry several instances of
 * the same contract, and picking the wrong one sends calls to another deployment.
 */
export function resolveModuleTarget(query: ModuleTargetQuery): KeelDeployment {
  const matches = findDeployments(query);
  if (matches.length === 1) return matches[0]!;
  const where = `${query.module}/${query.contract ?? "*"} on chain ${query.chainId}`;
  if (matches.length === 0) {
    const chains = moduleChains(query.module);
    throw new Error(
      `no deployment for ${where}${chains.length ? ` — known chains: ${chains.join(", ")}` : " — module has no recorded deployments"}`,
    );
  }
  const instances = [...new Set(matches.map((m) => m.instance))];
  throw new Error(`${matches.length} deployments match ${where}; pass instance (one of: ${instances.join(", ")})`);
}

/** Convenience wrapper returning just the address. */
export function moduleAddress(
  module: KeelUnitId,
  contract: string,
  chainId: number,
  instance?: string,
): `0x${string}` {
  return resolveModuleTarget(
    instance === undefined ? { module, contract, chainId } : { module, contract, chainId, instance },
  ).address;
}
