export type KeelStudioProjectOutcome = "storage-only" | "release";

export interface KeelStudioProjectIntakeInput {
  readonly title?: string;
  readonly description?: string;
  readonly outcome?: KeelStudioProjectOutcome;
  readonly chainId?: number;
  readonly release?: {
    readonly type?: "one-of-one" | "open-edition" | "limited-edition";
    readonly saleMechanism?: "fixed-price" | "auction" | "claim";
    readonly priceEth?: string;
    readonly startsAt?: string | null;
    readonly endsAt?: string | null;
  };
}

export type KeelStudioProjectIntakeResult =
  | {
      readonly status: "needs-input";
      readonly questions: readonly {
        readonly field: "title" | "description" | "outcome" | "chainId" | "priceEth";
        readonly question: string;
      }[];
    }
  | {
      readonly status: "ready";
      readonly title: string;
      readonly description: string;
      readonly outcome: KeelStudioProjectOutcome;
      readonly releaseIntent?: {
        readonly schema: "keel-release-intent@1";
        readonly chainId: number;
        readonly mode: "release";
        readonly collection: { readonly mode: "choose-in-studio" };
        readonly release: {
          readonly type: "one-of-one" | "open-edition" | "limited-edition";
          readonly supply: string;
          readonly saleMechanism: "fixed-price" | "auction" | "claim";
          readonly priceEth: string;
          readonly accessMode: "public";
          readonly startsAt: string | null;
          readonly endsAt: string | null;
        };
        readonly status: "editable-draft";
        readonly wallet: { readonly approvalRequiredNow: false; readonly transactionSubmitted: false };
      };
    };

function bounded(value: string | undefined, maximum: number): string | undefined {
  const result = value?.trim();
  if (result === undefined || result === "") return undefined;
  if (result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) throw new TypeError("Project text is not bounded printable text.");
  return result;
}

/**
 * Collects only the creator decisions needed before an agent stages a Studio
 * project. Storage-only is a complete result; a sale is never invented.
 */
export function prepareKeelStudioProjectIntake(input: KeelStudioProjectIntakeInput): KeelStudioProjectIntakeResult {
  const title = bounded(input.title, 160);
  const description = bounded(input.description, 2_000);
  const questions: Array<{ field: "title" | "description" | "outcome" | "chainId" | "priceEth"; question: string }> = [];
  if (title === undefined) questions.push({ field: "title", question: "What should this work be called?" });
  if (description === undefined) questions.push({ field: "description", question: "How should this work be described to collectors?" });
  if (input.outcome === undefined) questions.push({ field: "outcome", question: "Should I only store and verify the work, or also prepare an editable release/listing?" });
  if (input.outcome === "release") {
    if (!Number.isSafeInteger(input.chainId) || Number(input.chainId) <= 0) questions.push({ field: "chainId", question: "Which chain should the editable release use?" });
    if (bounded(input.release?.priceEth, 80) === undefined) questions.push({ field: "priceEth", question: "What price should I prefill? You can still change it in Studio." });
  }
  if (questions.length > 0) return Object.freeze({ status: "needs-input", questions: Object.freeze(questions) });

  if (input.outcome === "storage-only") {
    return Object.freeze({ status: "ready", title: title!, description: description!, outcome: "storage-only" });
  }

  const type = input.release?.type ?? "one-of-one";
  const saleMechanism = input.release?.saleMechanism ?? "fixed-price";
  const priceEth = bounded(input.release?.priceEth, 80)!;
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u.test(priceEth)) throw new TypeError("priceEth must be a non-negative decimal ETH amount.");
  const supply = type === "one-of-one" ? "1" : "0";
  return Object.freeze({
    status: "ready",
    title: title!,
    description: description!,
    outcome: "release",
    releaseIntent: {
      schema: "keel-release-intent@1",
      chainId: input.chainId!,
      mode: "release",
      collection: { mode: "choose-in-studio" },
      release: {
        type,
        supply,
        saleMechanism,
        priceEth,
        accessMode: "public",
        startsAt: input.release?.startsAt ?? null,
        endsAt: input.release?.endsAt ?? null,
      },
      status: "editable-draft",
      wallet: { approvalRequiredNow: false, transactionSubmitted: false },
    },
  } as const);
}
