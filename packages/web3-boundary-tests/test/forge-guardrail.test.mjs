// Guardrail tests for the repo-root Foundry footgun: a bare `forge` run at
// the monorepo root used to "succeed" against an empty default project and
// report nothing to compile, which read as a green run. The root
// foundry.toml stub must fail fast with a pointer to the real project, and
// the sanctioned --root invocations must keep working.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { repositoryRoot } from "./helpers/boundary-fixture.mjs";

const run = promisify(execFile);

async function forge(args, cwd) {
  try {
    const { stdout, stderr } = await run("forge", args, { cwd, timeout: 300_000 });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

describe("repo-root forge guardrail", () => {
  it("fails a bare `forge test` at the repo root with a pointer to the real project", async () => {
    const result = await forge(["test"], repositoryRoot);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("run_forge_inside_packages_contracts");
    expect(result.output).not.toContain("Nothing to compile");
  });

  it("fails a bare `forge build` at the repo root the same way", async () => {
    const result = await forge(["build"], repositoryRoot);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("run_forge_inside_packages_contracts");
  });

  it("keeps read-only cast tooling working from the repo root (valid config)", async () => {
    const { stdout } = await run("cast", ["calldata", "tokenURI(uint256)", "1"], { cwd: repositoryRoot, timeout: 60_000 });
    expect(stdout.trim()).toBe("0xc87b56dd0000000000000000000000000000000000000000000000000000000000000001");
  });

  it("leaves `forge --root packages/contracts` working from the repo root", async () => {
    const result = await forge(
      ["test", "--root", "packages/contracts", "--match-test", "testResolveModeIsErc5219"],
      repositoryRoot,
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("1 tests passed");
  });
});
