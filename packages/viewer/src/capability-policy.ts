// Relocated to @keel/protocol (pure policy algebra, no viewer/DOM deps) so the
// SDK, MCP, and any consumer can use it. Re-exported here so existing
// `@keel/viewer` imports keep working.
export {
  BROWSER_CAPABILITY_TOKENS,
  ALWAYS_DENIED_BROWSER_TOKENS,
  VIEWER_CAPABILITY_TOKENS,
  intersectCapabilities,
  walletIntentToken,
  walletSelectorToken,
  hostOperationToken,
  manifestCapabilityLayer,
  effectiveRuntimeCapabilities,
  allowedWalletIntents,
  allowedHostOperations,
  narrowOperationsByCapability,
  narrowWalletOperations,
  narrowHostOperations,
} from "@keel/protocol";
export type {
  BrowserCapabilityKey,
  CapabilityLayer,
  CapabilityExplanation,
  CapabilityIntersectionOptions,
  EffectiveCapabilities,
} from "@keel/protocol";
