export const KEEL_VERIFICATION_PRESENTATION_PROTOCOL = "keel-verification-presentation@1" as const;
export const KEEL_VERIFICATION_PRESENTATION_ALIAS = "keel://verification/presentation.json" as const;

export type KeelVerificationSealShape = "stamp" | "disc" | "shield" | "square";
export type KeelVerificationSealMotion = "slide" | "stamp" | "scale" | "rise" | "none";
export type KeelVerificationPanelType =
  | "overview"
  | "checks"
  | "storage"
  | "resources"
  | "identity"
  | "commitments"
  | "object-trail"
  | "staking"
  | "contract-facets";
export type KeelVerificationPageLayout = "stack" | "columns" | "grid";

export interface KeelVerificationSealPresentation {
  readonly glyph: string;
  readonly shape: KeelVerificationSealShape;
  readonly motion: KeelVerificationSealMotion;
  readonly color: "verification-state" | `#${string}`;
  readonly sizePx: number;
  readonly fadeInMs: number;
  readonly holdMs: number;
  readonly fadeOutMs: number;
}

export interface KeelVerificationPanelPresentation {
  readonly id: string;
  readonly type: KeelVerificationPanelType;
  readonly title?: string;
  readonly span?: 1 | 2 | 3;
}

export interface KeelVerificationPagePresentation {
  readonly id: string;
  readonly label: string;
  readonly layout: KeelVerificationPageLayout;
  readonly columns: 1 | 2 | 3;
  readonly panels: readonly KeelVerificationPanelPresentation[];
}

export interface KeelVerificationThemePresentation {
  readonly accent: "verification-state" | `#${string}`;
  readonly surface: `#${string}`;
  readonly text: `#${string}`;
  readonly muted: `#${string}`;
  readonly radiusPx: number;
  /**
   * Optional verified Keel item containing additional text/css. The shell
   * will only install it after the ordinary item digest and length checks pass.
   */
  readonly cssResource?: {
    readonly id: string;
    readonly digest: `0x${string}`;
    readonly byteLength: number;
  };
}

export interface KeelVerificationOverlayPresentation {
  readonly placement: "left" | "right" | "center";
  readonly width: "compact" | "standard" | "wide";
  readonly navigation: "tabs" | "stepper";
  readonly initialPage: string;
}

/**
 * Presentation-only configuration for the shared verifier. It can rearrange
 * proof data but cannot add proof claims, change check results, or execute art.
 * The verifier engine and the manifest are independently versioned objects.
 */
export interface KeelVerificationPresentationManifest {
  readonly protocol: typeof KEEL_VERIFICATION_PRESENTATION_PROTOCOL;
  readonly revision: number;
  readonly seal: KeelVerificationSealPresentation;
  readonly overlay: KeelVerificationOverlayPresentation;
  readonly theme: KeelVerificationThemePresentation;
  readonly pages: readonly KeelVerificationPagePresentation[];
}

export interface KeelVerificationPresentationOverrides {
  readonly revision?: number;
  readonly seal?: Partial<KeelVerificationSealPresentation>;
  readonly overlay?: Partial<KeelVerificationOverlayPresentation>;
  readonly theme?: Partial<KeelVerificationThemePresentation>;
  readonly pages?: readonly KeelVerificationPagePresentation[];
}

export const DEFAULT_KEEL_VERIFICATION_PRESENTATION: KeelVerificationPresentationManifest = Object.freeze({
  protocol: KEEL_VERIFICATION_PRESENTATION_PROTOCOL,
  revision: 2,
  seal: Object.freeze({
    glyph: "S",
    shape: "stamp",
    motion: "slide",
    color: "verification-state",
    sizePx: 40,
    fadeInMs: 420,
    holdMs: 650,
    fadeOutMs: 900,
  }),
  overlay: Object.freeze({
    placement: "left",
    width: "wide",
    navigation: "tabs",
    initialPage: "overview",
  }),
  theme: Object.freeze({
    accent: "verification-state",
    surface: "#07120f",
    text: "#d9e8e3",
    muted: "#748d85",
    radiusPx: 22,
  }),
  pages: Object.freeze([
    Object.freeze({
      id: "overview",
      label: "Proof",
      layout: "stack",
      columns: 1,
      panels: Object.freeze([
        Object.freeze({ id: "proof-summary", type: "overview", span: 1 }),
        Object.freeze({ id: "verification-checks", type: "checks", span: 1 }),
      ]),
    }),
    Object.freeze({
      id: "sources",
      label: "Files",
      layout: "columns",
      columns: 2,
      panels: Object.freeze([
        Object.freeze({ id: "storage-sources", type: "storage", span: 1 }),
        Object.freeze({ id: "verified-resources", type: "resources", span: 1 }),
      ]),
    }),
    Object.freeze({
      id: "provenance",
      label: "Trail",
      layout: "grid",
      columns: 2,
      panels: Object.freeze([
        Object.freeze({ id: "token-identity", type: "identity", span: 1 }),
        Object.freeze({ id: "version-commitments", type: "commitments", span: 1 }),
        Object.freeze({ id: "keel-object-trail", type: "object-trail", span: 2 }),
        Object.freeze({ id: "stake-object", type: "staking", span: 2 }),
        Object.freeze({ id: "contract-facets", type: "contract-facets", span: 2 }),
      ]),
    }),
  ]),
});

const PANEL_TYPES = new Set<KeelVerificationPanelType>([
  "overview", "checks", "storage", "resources", "identity", "commitments", "object-trail", "staking", "contract-facets",
]);
const SEAL_SHAPES = new Set<KeelVerificationSealShape>(["stamp", "disc", "shield", "square"]);
const SEAL_MOTIONS = new Set<KeelVerificationSealMotion>(["slide", "stamp", "scale", "rise", "none"]);
const PAGE_LAYOUTS = new Set<KeelVerificationPageLayout>(["stack", "columns", "grid"]);

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || !/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase kebab-case identifier.`);
  }
}

function label(value: unknown, name: string, maximum = 64): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid.`);
  }
}

function integer(value: unknown, name: string, minimum: number, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function color(value: unknown, name: string, stateAllowed: boolean): asserts value is "verification-state" | `#${string}` {
  if (stateAllowed && value === "verification-state") return;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/u.test(value)) {
    throw new TypeError(`${name} must be a lowercase six-digit hex color${stateAllowed ? " or verification-state" : ""}.`);
  }
}

/** Validate and detach an untrusted presentation manifest before rendering it. */
export function normalizeKeelVerificationPresentationManifest(
  input: KeelVerificationPresentationManifest,
): KeelVerificationPresentationManifest {
  if (input?.protocol !== KEEL_VERIFICATION_PRESENTATION_PROTOCOL) throw new TypeError("Unsupported verification presentation protocol.");
  integer(input.revision, "revision", 1, Number.MAX_SAFE_INTEGER);
  label(input.seal?.glyph, "seal glyph", 4);
  if (!SEAL_SHAPES.has(input.seal.shape)) throw new TypeError("Unsupported seal shape.");
  if (!SEAL_MOTIONS.has(input.seal.motion)) throw new TypeError("Unsupported seal motion.");
  color(input.seal.color, "seal color", true);
  integer(input.seal.sizePx, "seal size", 24, 72);
  integer(input.seal.fadeInMs, "seal fade-in", 50, 3_000);
  integer(input.seal.holdMs, "seal hold", 0, 10_000);
  integer(input.seal.fadeOutMs, "seal fade-out", 50, 3_000);
  if (!(["left", "right", "center"] as const).includes(input.overlay?.placement)) throw new TypeError("Unsupported overlay placement.");
  if (!(["compact", "standard", "wide"] as const).includes(input.overlay.width)) throw new TypeError("Unsupported overlay width.");
  if (!(["tabs", "stepper"] as const).includes(input.overlay.navigation)) throw new TypeError("Unsupported overlay navigation.");
  identifier(input.overlay.initialPage, "initial page");
  color(input.theme?.accent, "theme accent", true);
  color(input.theme.surface, "theme surface", false);
  color(input.theme.text, "theme text", false);
  color(input.theme.muted, "theme muted", false);
  integer(input.theme.radiusPx, "theme radius", 0, 48);
  if (input.theme.cssResource !== undefined) {
    identifier(input.theme.cssResource.id, "CSS resource id");
    if (!/^0x[0-9a-f]{64}$/u.test(input.theme.cssResource.digest)) throw new TypeError("CSS resource digest must be canonical SHA-256 hex.");
    integer(input.theme.cssResource.byteLength, "CSS resource byte length", 1, 65_536);
  }
  if (!Array.isArray(input.pages) || input.pages.length === 0 || input.pages.length > 8) throw new TypeError("Verification presentation requires one to eight pages.");

  const pageIds = new Set<string>();
  const panelIds = new Set<string>();
  const pages = input.pages.map((page: KeelVerificationPagePresentation) => {
    identifier(page.id, "page id");
    if (pageIds.has(page.id)) throw new TypeError(`Duplicate verification page ${page.id}.`);
    pageIds.add(page.id);
    label(page.label, "page label", 32);
    if (!PAGE_LAYOUTS.has(page.layout)) throw new TypeError(`Unsupported layout for page ${page.id}.`);
    integer(page.columns, "page columns", 1, 3);
    if (!Array.isArray(page.panels) || page.panels.length === 0 || page.panels.length > 16) throw new TypeError(`Page ${page.id} requires one to sixteen panels.`);
    const panels = page.panels.map((panel: KeelVerificationPanelPresentation) => {
      identifier(panel.id, "panel id");
      if (panelIds.has(panel.id)) throw new TypeError(`Duplicate verification panel ${panel.id}.`);
      panelIds.add(panel.id);
      if (!PANEL_TYPES.has(panel.type)) throw new TypeError(`Unsupported verification panel type ${String(panel.type)}.`);
      if (panel.title !== undefined) label(panel.title, "panel title", 64);
      const span = panel.span ?? 1;
      integer(span, "panel span", 1, 3);
      if (span > page.columns) throw new TypeError(`Panel ${panel.id} spans more columns than page ${page.id}.`);
      return Object.freeze({ ...panel, span: span as 1 | 2 | 3 });
    });
    return Object.freeze({ ...page, panels: Object.freeze(panels) });
  });
  if (!pageIds.has(input.overlay.initialPage)) throw new TypeError("The initial verification page does not exist.");

  return Object.freeze({
    protocol: KEEL_VERIFICATION_PRESENTATION_PROTOCOL,
    revision: input.revision,
    seal: Object.freeze({ ...input.seal }),
    overlay: Object.freeze({ ...input.overlay }),
    theme: Object.freeze({ ...input.theme }),
    pages: Object.freeze(pages),
  });
}

/** Build a complete validated manifest from small Studio-facing overrides. */
export function createKeelVerificationPresentationManifest(
  overrides: KeelVerificationPresentationOverrides = {},
): KeelVerificationPresentationManifest {
  return normalizeKeelVerificationPresentationManifest({
    ...DEFAULT_KEEL_VERIFICATION_PRESENTATION,
    revision: overrides.revision ?? DEFAULT_KEEL_VERIFICATION_PRESENTATION.revision,
    seal: { ...DEFAULT_KEEL_VERIFICATION_PRESENTATION.seal, ...overrides.seal },
    overlay: { ...DEFAULT_KEEL_VERIFICATION_PRESENTATION.overlay, ...overrides.overlay },
    theme: { ...DEFAULT_KEEL_VERIFICATION_PRESENTATION.theme, ...overrides.theme },
    pages: overrides.pages ?? DEFAULT_KEEL_VERIFICATION_PRESENTATION.pages,
  });
}
