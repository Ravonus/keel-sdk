/**
 * Sibling checkouts some suites read, and whether they are here.
 *
 * A few tests deliberately cross a repository boundary: they assert that this
 * repository and a neighbouring one still agree about something neither can
 * check alone. That is the whole point of them, and it means they cannot run
 * where the neighbour is not checked out.
 *
 * This repository is public and some of those neighbours are private, so its
 * CI cannot fetch them without putting a credential in a public workflow. The
 * answer is not a token: it is that the private repository runs these tests
 * itself, where the checkout it owns is already present and the public one it
 * needs can be fetched with no credential at all. The dependency points the
 * safe way round.
 *
 * ## Why a skip needs a guard
 *
 * A test that skips when its input is missing is one bad default away from
 * skipping everywhere, forever, while the dashboard stays green. So absence is
 * a skip only by default: set `KEEL_REQUIRE_SIBLINGS=1` and a missing sibling
 * becomes a hard failure instead. The CI job that owns the sibling sets it, so
 * "these never actually ran anywhere" is a state that fails loudly rather than
 * one nobody notices.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function present(directory) {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve one or more sibling checkouts.
 *
 * Returns `{ skip }` suitable for a node:test options object: `false` when
 * every sibling is present, or a sentence naming the missing ones when not.
 */
export function siblingRepositories(...names) {
  const missing = names.filter((name) => !present(path.resolve(ROOT, `../${name}`)));
  if (missing.length === 0) return { skip: false, missing };
  if (process.env.KEEL_REQUIRE_SIBLINGS === "1") {
    throw new Error(
      `KEEL_REQUIRE_SIBLINGS=1, but ${missing.join(" and ")} ` +
      `${missing.length === 1 ? "is" : "are"} not checked out next to this repository. ` +
      "This job is the one that is supposed to run these tests, so a missing sibling is a failure, not a skip.",
    );
  }
  return {
    skip: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not checked out next to this repository.`,
    missing,
  };
}

/**
 * A `test` that carries the skip for every case in a file, so a cross-repo
 * suite needs one line at the top rather than an option on each case.
 */
export function siblingTest(nodeTest, ...names) {
  const { skip } = siblingRepositories(...names);
  return (name, fn) => nodeTest(name, skip === false ? {} : { skip }, fn);
}
