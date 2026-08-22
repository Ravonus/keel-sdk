/**
 * Where a module's readable source lives — without Keel ever holding it.
 *
 * The verification story only works if a holder can read the source that the
 * on-chain bytes were built from. The obvious way to guarantee that is to store
 * the source too, and it is the wrong way: it makes Keel a code host, puts
 * it in the business of moderating and retaining other people's repositories,
 * and doubles the bytes for something a public forge already serves better.
 *
 * So Keel stores none of it. What it stores is a *pointer that cannot drift*
 * plus the digests that make the pointer checkable:
 *
 *   - the source must be public, because a verification anyone can repeat is
 *     the only kind worth recording;
 *   - the ref must be an immutable commit, never a branch or a tag — both of
 *     those move, and a receipt pinned to something that moves is a receipt
 *     that expires silently;
 *   - the build recipe already names every input file by digest, so a repo that
 *     is later rewritten, force-pushed, renamed, or deleted does not invalidate
 *     the proof. It only means nobody can re-run it from that host any more.
 *
 * That last property is the one that makes no-custody defensible. The receipt
 * does not depend on the forge staying up; it depends on the forge having been
 * up once, in public, at a commit anybody could have checked. If the repository
 * disappears tomorrow, the recipe still says exactly which bytes went in, and
 * anyone holding a copy of the source can still reproduce the output.
 *
 * ## Adding a host
 *
 * `provider` is open on purpose. GitHub is implemented because it is where the
 * modules are today; another forge — including an AI-authored one — plugs in by
 * registering an archive resolver, without any other part of the system
 * learning about it. The rules a provider has to satisfy are the same three
 * above: public, immutable ref, fetchable archive.
 */

import type { Integrity } from "./types.js";

export const KEEL_SOURCE_ORIGIN_PROTOCOL = "keel-source-origin@1" as const;

/** Known forges. Not a closed set — see the header note. */
export type KeelSourceProvider = "github" | (string & {});

export interface KeelSourceOrigin {
  readonly protocol: typeof KEEL_SOURCE_ORIGIN_PROTOCOL;
  readonly provider: KeelSourceProvider;
  /** Owner, organisation, or namespace on the provider. */
  readonly owner: string;
  readonly repo: string;
  /**
   * An immutable commit identifier. A branch or tag is refused: it moves, and a
   * receipt pinned to a moving target stops being true without saying so.
   */
  readonly commit: string;
  /** Directory within the repository that the recipe root maps to. */
  readonly path?: string;
  /**
   * Keel records this because a verification nobody else can repeat is not a
   * verification. It is not a claim about licensing.
   */
  readonly visibility: "public";
  /**
   * Digest of the exact archive that was fetched and built, when one was. Lets
   * a later run prove it got the same tree without trusting the forge to serve
   * the same bytes for the same commit twice.
   */
  readonly archiveIntegrity?: Integrity;
}

/** A full 40-hex git object id, or a 64-hex one for a SHA-256 repository. */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/u;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const SAFE_PATH = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\x21-\x7e]+$/u;

export function assertValidKeelSourceOrigin(origin: KeelSourceOrigin): KeelSourceOrigin {
  if (origin?.protocol !== KEEL_SOURCE_ORIGIN_PROTOCOL) {
    throw new TypeError("origin.protocol must be keel-source-origin@1.");
  }
  if (typeof origin.provider !== "string" || !PROVIDER.test(origin.provider)) {
    throw new TypeError("origin.provider must be a lower-case provider key.");
  }
  if (!SEGMENT.test(origin.owner ?? "")) throw new TypeError("origin.owner is invalid.");
  if (!SEGMENT.test(origin.repo ?? "")) throw new TypeError("origin.repo is invalid.");
  if (typeof origin.commit !== "string" || !COMMIT.test(origin.commit)) {
    throw new TypeError(
      "origin.commit must be a full commit hash. A branch or tag moves, and a receipt pinned to it expires silently.",
    );
  }
  if (origin.path !== undefined && (origin.path.length > 512 || !SAFE_PATH.test(origin.path))) {
    throw new TypeError("origin.path must be a safe relative path without traversal.");
  }
  if (origin.visibility !== "public") {
    throw new TypeError("origin.visibility must be public: a verification nobody else can repeat is not a verification.");
  }
  return origin;
}

/** Human-facing permalink. Stable because the commit is. */
export function keelSourceOriginUrl(origin: KeelSourceOrigin): string {
  assertValidKeelSourceOrigin(origin);
  if (origin.provider === "github") {
    const suffix = origin.path === undefined ? "" : `/${origin.path}`;
    return `https://github.com/${origin.owner}/${origin.repo}/tree/${origin.commit}${suffix}`;
  }
  throw new Error(`No permalink resolver is registered for provider ${origin.provider}.`);
}

/**
 * Where the exact tree can be fetched from, as a tarball.
 *
 * Split from the permalink because they are different trust surfaces: one is
 * for a person to read, the other is bytes a verifier will build. A provider
 * that cannot offer an immutable archive at a commit cannot be supported, since
 * without one there is nothing to reproduce from.
 */
export function keelSourceArchiveUrl(origin: KeelSourceOrigin): string {
  assertValidKeelSourceOrigin(origin);
  if (origin.provider === "github") {
    return `https://codeload.github.com/${origin.owner}/${origin.repo}/tar.gz/${origin.commit}`;
  }
  throw new Error(`No archive resolver is registered for provider ${origin.provider}.`);
}

/** The `repository` field a `KeelSourceReceipt` carries. */
export function keelSourceRepositoryRef(
  origin: KeelSourceOrigin,
  path: string,
): { readonly url: string; readonly revision: string; readonly path: string } {
  assertValidKeelSourceOrigin(origin);
  return {
    url: origin.provider === "github"
      ? `https://github.com/${origin.owner}/${origin.repo}`
      : `${origin.provider}:${origin.owner}/${origin.repo}`,
    revision: origin.commit,
    path,
  };
}
