export const KEEL_VIEWER_BRIDGE_PROTOCOL = "keel-viewer-verification@1" as const;

export type KeelViewerPresentationMode = "character" | "weapon";

export interface KeelViewerPresentationCommand {
  readonly protocol: typeof KEEL_VIEWER_BRIDGE_PROTOCOL;
  readonly action: "set-presentation";
  readonly presentation: KeelViewerPresentationMode;
}

export interface KeelViewerPresentationRequest {
  readonly protocol: typeof KEEL_VIEWER_BRIDGE_PROTOCOL;
  readonly action: "get-presentation";
}

export interface KeelViewerPresentationState {
  readonly protocol: typeof KEEL_VIEWER_BRIDGE_PROTOCOL;
  readonly action: "presentation-state";
  readonly presentation: KeelViewerPresentationMode;
  readonly character: {
    readonly tokenId: string;
    readonly seed: string;
    readonly appearance: string;
  };
  readonly weapon: {
    readonly id: string;
    readonly name: string;
    readonly assetId: string;
    readonly build: Readonly<Record<string, string>>;
    readonly projectileStyle: string;
    readonly combat: {
      readonly longRangeMode: string;
      readonly cooldownMs: number;
      readonly projectileSpeed: number;
      readonly count: number;
      readonly spread: number;
    };
  };
}

export function createKeelViewerPresentationCommand(
  presentation: KeelViewerPresentationMode,
): KeelViewerPresentationCommand {
  return Object.freeze({ protocol: KEEL_VIEWER_BRIDGE_PROTOCOL, action: "set-presentation", presentation });
}

export function createKeelViewerPresentationRequest(): KeelViewerPresentationRequest {
  return Object.freeze({ protocol: KEEL_VIEWER_BRIDGE_PROTOCOL, action: "get-presentation" });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Safely narrow an untrusted iframe message before showing viewer data in host UI. */
export function isKeelViewerPresentationState(value: unknown): value is KeelViewerPresentationState {
  if (!object(value) || value.protocol !== KEEL_VIEWER_BRIDGE_PROTOCOL || value.action !== "presentation-state") return false;
  if (value.presentation !== "character" && value.presentation !== "weapon") return false;
  if (!object(value.character) || !object(value.weapon) || !object(value.weapon.build) || !object(value.weapon.combat)) return false;
  return typeof value.character.tokenId === "string"
    && typeof value.character.seed === "string"
    && typeof value.character.appearance === "string"
    && typeof value.weapon.id === "string"
    && typeof value.weapon.name === "string"
    && typeof value.weapon.assetId === "string"
    && typeof value.weapon.projectileStyle === "string"
    && typeof value.weapon.combat.longRangeMode === "string"
    && typeof value.weapon.combat.cooldownMs === "number"
    && typeof value.weapon.combat.projectileSpeed === "number"
    && typeof value.weapon.combat.count === "number"
    && typeof value.weapon.combat.spread === "number"
    && Object.values(value.weapon.build).every((entry) => typeof entry === "string");
}
