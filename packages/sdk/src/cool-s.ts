import type { Address, Hex } from "./types.js";

/** Immutable equipment slot used by the Cool S target table v1. */
export const COOL_S_DUPLICATOR_SLOT_V1 = 6 as const;

/** Studio must not describe the current G0 seed flow as future-block/VRF fairness. */
export const COOL_S_ENTROPY_PROOF_STATUS = "g0-unproven" as const;

/** ERC-165 interface id for equipmentDescriptor(uint256). */
export const KEEL_ERC1155_EQUIPMENT_DESCRIPTOR_INTERFACE_ID = "0x405b502e" as const;

export interface CoolSLinkedLibraryDeployment {
  readonly keelViewerContextDispatch: Address;
  readonly keelCollectionFreezeValidation: Address;
  readonly keelMintBoundEquipmentProvision: Address;
}

export interface CoolSEquipmentSupplyRoleObservation {
  readonly definitionId: Hex;
  readonly assetCollection: Address;
  readonly assetTokenId: bigint;
  readonly engineHasMinterRole: boolean;
  readonly engineHasReserverRole: boolean;
  readonly inventoryHasMinterRole: boolean;
  readonly inventoryHasReserverRole: boolean;
  readonly descriptorInterfaceAdvertised: boolean;
  readonly descriptorMatchesDefinition: boolean;
  readonly assetDescriptorCommitment: Hex;
  readonly definitionDescriptorCommitment: Hex;
  readonly computedDefinitionDescriptorCommitment: Hex;
}

/**
 * Frozen Cool S supply authority belongs exclusively to the Inventory child
 * ReservationEngine. The parent Inventory must not retain either Vault role.
 */
export function coolSEquipmentSupplyRolesReady(
  supplies: readonly CoolSEquipmentSupplyRoleObservation[],
): boolean {
  return supplies.length > 0 && supplies.every((supply) => (
    supply.engineHasMinterRole
    && supply.engineHasReserverRole
    && !supply.inventoryHasMinterRole
    && !supply.inventoryHasReserverRole
  ));
}

/** Exact Phase-1 descriptor closure required for a Cool S target asset. */
export function coolSEquipmentDescriptorReady(
  supply: CoolSEquipmentSupplyRoleObservation,
): boolean {
  return supply.descriptorInterfaceAdvertised
    && supply.descriptorMatchesDefinition
    && supply.assetDescriptorCommitment !== `0x${"00".repeat(32)}`
    && supply.definitionDescriptorCommitment !== `0x${"00".repeat(32)}`
    && supply.definitionDescriptorCommitment.toLowerCase()
      === supply.computedDefinitionDescriptorCommitment.toLowerCase();
}
