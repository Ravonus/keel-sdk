import {
  composeStakeObjectStack,
  type KeelProjectComponent,
  type KeelProjectStack,
} from "@keel/protocol";

export interface VaultRunnerStakeObjectPlan {
  readonly baseStack: KeelProjectStack;
  /** The character-only controller/runtime component to remove in map mode. */
  readonly characterComponentId: string;
  /** Map code plus exact seed/arguments/variables resources to append. */
  readonly mapComponents: readonly KeelProjectComponent[];
}

export interface VaultRunnerStakeObjectComposition {
  readonly stack: KeelProjectStack;
  readonly removedComponentIds: readonly string[];
  readonly keptSharedComponentIds: readonly string[];
  readonly appendedMapComponentIds: readonly string[];
}

/**
 * Build Vault Runner's staked stack from the same project graph used by the
 * base character viewer. The character script is the only implicit removal;
 * shared renderers, loaders, audio, and libraries stay byte-identical.
 */
export function composeVaultRunnerStakeObject(
  plan: VaultRunnerStakeObjectPlan,
): VaultRunnerStakeObjectComposition {
  const result = composeStakeObjectStack(plan.baseStack, {
    removeComponentIds: [plan.characterComponentId],
    addComponents: plan.mapComponents,
  });
  return {
    stack: result.stack,
    removedComponentIds: result.removedComponentIds,
    keptSharedComponentIds: result.keptComponentIds,
    appendedMapComponentIds: plan.mapComponents.map((component) => component.id),
  };
}
