import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createIntegrity, keelBuildRecipeDigest, canonicalJson, utf8ToBytes } from "../packages/protocol/dist/index.js";
import { verifyKeelBuildRecipe } from "../packages/builder/dist/index.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(repositoryRoot, "packages/builder/dist/cli.js");

function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024, ...options });
}

const BASE_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "es2022",
      module: "es2022",
      moduleResolution: "bundler",
      lib: ["es2022", "dom"],
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      noEmit: true,
    },
  },
  null,
  2,
)}\n`;

const GREETER_SOURCE = `/*! greeter: a keel workspace fixture. */
export function greet(name: string): string {
  if (name.length === 0) throw new RangeError("name required");
  return \`hello \${name}\`;
}

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
`;

const GREETER_VECTORS = `export default [
  { name: "greet returns a greeting", run: (m) => m.greet("keel"), expect: "hello keel" },
  { name: "sum adds", run: (m) => m.sum([1, 2, 3]), expect: 6 },
];
`;

const ADDER_SOURCE = `export function add(left: number, right: number): number {
  return left + right;
}
`;

/** A temp workspace in exactly the keel-modules layout: modules/<name>/... over a shared tsconfig base. */
async function scaffoldWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "keel-module-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "tsconfig.base.json"), BASE_TSCONFIG);
  const modules = [
    { id: "adder", summary: "Adds numbers.", source: ADDER_SOURCE, vectors: undefined },
    { id: "greeter", summary: "Greets by name.", source: GREETER_SOURCE, vectors: GREETER_VECTORS },
  ];
  for (const module of modules) {
    const directory = path.join(root, "modules", module.id);
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(
      path.join(directory, "keel.module.json"),
      `${JSON.stringify({ schema: "keel.jsmodule@1", id: module.id, entry: "src/index.ts", license: "MIT", summary: module.summary }, null, 2)}\n`,
    );
    await writeFile(
      path.join(directory, "tsconfig.json"),
      `${JSON.stringify({ extends: "../../tsconfig.base.json", include: ["src"] }, null, 2)}\n`,
    );
    await writeFile(path.join(directory, "src/index.ts"), module.source);
    if (module.vectors !== undefined) {
      await mkdir(path.join(directory, "test"), { recursive: true });
      await writeFile(path.join(directory, "test/vectors.mjs"), module.vectors);
    }
  }
  return root;
}

test("keel module build --all walks the keel-modules layout and records the compact stage", async (t) => {
  const root = await scaffoldWorkspace(t);
  const { stdout } = await runCli(["module", "build", "--all", "--root", root]);
  assert.match(stdout, /Built modules\/adder .*reproducible-build/u);
  assert.match(stdout, /Built modules\/greeter .*reproducible-build/u);

  for (const id of ["adder", "greeter"]) {
    const distDirectory = path.join(root, "modules", id, "dist");
    const recipe = JSON.parse(await readFile(path.join(distDirectory, "keel-build-recipe.json"), "utf8"));
    assert.equal(recipe.protocol, "keel-build-recipe@2");
    assert.equal(recipe.compact.tool.name, "terser");
    assert.match(recipe.compact.tool.version, /^\d+\.\d+\.\d+$/u);
    assert.ok(["esbuild", "terser"].includes(recipe.compact.winner));
    assert.ok(recipe.compact.candidateBytes.esbuild > 0);
    assert.ok(recipe.compact.candidateBytes.terser > 0);
    assert.ok(recipe.compact.options.passes >= 2);
    assert.equal(recipe.compact.options.mangle, true);
    assert.equal(recipe.compact.options.keepComments, false);

    // The shipped bytes are the recorded winner, byte for byte.
    const shipped = new Uint8Array(await readFile(path.join(distDirectory, `${id}.min.js`)));
    const shippedIntegrity = await createIntegrity(shipped);
    assert.equal(shippedIntegrity.digest, recipe.output.integrity.digest);
    const winnerSize = recipe.compact.winner === "terser" ? recipe.compact.candidateBytes.terser : recipe.compact.candidateBytes.esbuild;
    assert.equal(shipped.byteLength, winnerSize);

    // A third party reproduces the whole pipeline including the compact stage.
    const verification = await verifyKeelBuildRecipe({ recipe, root: path.join(root, "modules", id) });
    assert.equal(verification.verdict, "reproduced", verification.issues.join("; "));

    const receipt = JSON.parse(await readFile(path.join(distDirectory, "keel-source-receipt.json"), "utf8"));
    assert.equal(receipt.disposition, "reproducible-build");
    assert.equal(receipt.buildRecipeDigest, await keelBuildRecipeDigest(recipe));
  }
});

test("keel module build --no-compact still emits a valid keel-build-recipe@1", async (t) => {
  const root = await scaffoldWorkspace(t);
  await runCli(["module", "build", path.join(root, "modules", "adder"), "--no-compact"]);
  const recipe = JSON.parse(await readFile(path.join(root, "modules/adder/dist/keel-build-recipe.json"), "utf8"));
  assert.equal(recipe.protocol, "keel-build-recipe@1");
  assert.equal(recipe.compact, undefined);
  await keelBuildRecipeDigest(recipe); // @1 records remain valid under the extended schema
  const verification = await verifyKeelBuildRecipe({ recipe, root: path.join(root, "modules", "adder") });
  assert.equal(verification.verdict, "reproduced");
});

test("a stamp banner ships in the bytes and the stamped build reproduces exactly", async (t) => {
  const root = await scaffoldWorkspace(t);
  const moduleDirectory = path.join(root, "modules", "greeter");
  const stampPath = path.join(moduleDirectory, "stamp.txt");
  await writeFile(stampPath, " KEEL\n <>< on-chain art ><>\n");
  await runCli(["module", "build", moduleDirectory, "--stamp", stampPath]);

  const shippedText = await readFile(path.join(moduleDirectory, "dist/greeter.min.js"), "utf8");
  assert.ok(shippedText.startsWith("/*!\n KEEL\n <>< on-chain art ><>\n*/\n"), "banner must lead the shipped bytes");

  const recipe = JSON.parse(await readFile(path.join(moduleDirectory, "dist/keel-build-recipe.json"), "utf8"));
  assert.equal(recipe.compact.stamp.path, "stamp.txt");
  const stampIntegrity = await createIntegrity(new Uint8Array(await readFile(stampPath)));
  assert.equal(recipe.compact.stamp.integrity.digest, stampIntegrity.digest);

  // Byte-exact third-party reproduction, stamp included.
  const verification = await verifyKeelBuildRecipe({ recipe, root: moduleDirectory });
  assert.equal(verification.verdict, "reproduced", verification.issues.join("; "));
  const shippedIntegrity = await createIntegrity(new Uint8Array(await readFile(path.join(moduleDirectory, "dist/greeter.min.js"))));
  assert.equal(verification.rebuiltOutput.digest, shippedIntegrity.digest);

  // A changed stamp is a changed input, and the verdict says so.
  await writeFile(stampPath, "different art\n");
  const tampered = await verifyKeelBuildRecipe({ recipe, root: moduleDirectory });
  assert.equal(tampered.reproduced, false);
  assert.equal(tampered.verdict, "source-changed");
  assert.ok(tampered.issues.some((issue) => issue.includes("stamp.txt")), tampered.issues.join("; "));

  // A stamp that would terminate its own banner is refused outright.
  await writeFile(stampPath, "sneaky */ export const x = 1;\n");
  await assert.rejects(() => runCli(["module", "build", moduleDirectory, "--stamp", stampPath]), /terminate its own banner/u);
});

test("--keep-comments carries legal comments into the shipped bytes and into the recipe", async (t) => {
  const root = await scaffoldWorkspace(t);
  const moduleDirectory = path.join(root, "modules", "greeter");
  await runCli(["module", "build", moduleDirectory, "--keep-comments"]);
  const shippedText = await readFile(path.join(moduleDirectory, "dist/greeter.min.js"), "utf8");
  assert.match(shippedText, /greeter: a keel workspace fixture/u);
  const recipe = JSON.parse(await readFile(path.join(moduleDirectory, "dist/keel-build-recipe.json"), "utf8"));
  assert.equal(recipe.compact.options.keepComments, true);
  assert.equal(recipe.options.legalComments, "inline");
  const verification = await verifyKeelBuildRecipe({ recipe, root: moduleDirectory });
  assert.equal(verification.verdict, "reproduced", verification.issues.join("; "));

  const plain = await runCli(["module", "build", moduleDirectory]);
  assert.ok(plain.stdout.length > 0);
  const stripped = await readFile(path.join(moduleDirectory, "dist/greeter.min.js"), "utf8");
  assert.ok(!stripped.includes("workspace fixture"), "without the flag the comment is dropped");
});

test("keel module test runs vectors against source and shipped bytes and fails on divergence", async (t) => {
  const root = await scaffoldWorkspace(t);
  const moduleDirectory = path.join(root, "modules", "greeter");
  await assert.rejects(() => runCli(["module", "test", moduleDirectory]), /module build/u);
  await runCli(["module", "build", moduleDirectory]);
  const passing = await runCli(["module", "test", moduleDirectory]);
  assert.match(passing.stdout, /greeter: passed/u);

  const all = await runCli(["module", "build", "--all", "--root", root]).then(() => runCli(["module", "test", "--all", "--root", root]));
  assert.match(all.stdout, /modules\/adder: skipped \(no test\/vectors\.mjs\)/u);
  assert.match(all.stdout, /modules\/greeter: passed \(2 vectors\)/u);

  // Tampered shipped bytes behave differently from the readable source: fail.
  await writeFile(
    path.join(moduleDirectory, "dist/greeter.min.js"),
    'export function greet(n){return "bye "+n}export function sum(v){return 0}\n',
  );
  await assert.rejects(async () => {
    await runCli(["module", "test", moduleDirectory]);
  }, (error) => {
    assert.match(String(error.stdout), /greeter: FAILED/u);
    assert.equal(error.code, 1);
    return true;
  });
});

test("keel module compact --candidate verifies behavior and emits a behaviorally-verified receipt", async (t) => {
  const root = await scaffoldWorkspace(t);
  const moduleDirectory = path.join(root, "modules", "greeter");
  await runCli(["module", "build", moduleDirectory]);

  // An "externally minified" candidate that is genuinely equivalent.
  const candidatePath = path.join(root, "candidate.js");
  await writeFile(
    candidatePath,
    'export function greet(n){if(n.length===0)throw new RangeError("name required");return"hello "+n}export function sum(v){let t=0;for(const x of v)t+=x;return t}\n',
  );
  const { stdout } = await runCli(["module", "compact", moduleDirectory, "--candidate", candidatePath]);
  assert.match(stdout, /matched the readable source on all 2 vectors/u);
  assert.match(stdout, /reproducible-build > behaviorally-verified/u);

  const receipt = JSON.parse(await readFile(path.join(moduleDirectory, "dist/keel-candidate-receipt.json"), "utf8"));
  assert.equal(receipt.protocol, "keel-source-receipt@1");
  assert.equal(receipt.disposition, "behaviorally-verified");
  assert.equal(receipt.verification, undefined, "a behavioral receipt never claims a rebuild");
  assert.equal(receipt.buildRecipeDigest, undefined);
  assert.equal(receipt.behavior.protocol, "keel-source-behavior-verification@1");
  assert.equal(receipt.behavior.vectors.length, 2);
  for (const vector of receipt.behavior.vectors) assert.match(vector.valueDigest, /^0x[0-9a-f]{64}$/u);
  const vectorsIntegrity = await createIntegrity(new Uint8Array(await readFile(path.join(moduleDirectory, "test/vectors.mjs"))));
  assert.equal(receipt.behavior.vectorsDigest, vectorsIntegrity.digest);
  const candidateIntegrity = await createIntegrity(new Uint8Array(await readFile(candidatePath)));
  assert.equal(receipt.output.digest, candidateIntegrity.digest);
  // The evidence digest is the digest of each vector's canonical value.
  const greeting = (await createIntegrity(utf8ToBytes(canonicalJson("hello keel")))).digest;
  assert.equal(receipt.behavior.vectors[0].valueDigest, greeting);

  // A diverging candidate gets no receipt.
  await writeFile(candidatePath, 'export function greet(n){return"hi "+n}export function sum(v){return 0}\n');
  await assert.rejects(() => runCli(["module", "compact", moduleDirectory, "--candidate", candidatePath]), /diverges/u);

  // No vectors, no behavioral verification: refuse.
  await assert.rejects(
    () => runCli(["module", "compact", path.join(root, "modules", "adder"), "--candidate", candidatePath]),
    /vectors/u,
  );
});

test("keel module index writes the keel-module-catalog@3 the site reads", async (t) => {
  const root = await scaffoldWorkspace(t);
  await assert.rejects(() => runCli(["module", "index", "--root", root]), /module build --all/u);
  await runCli(["module", "build", "--all", "--root", root]);
  const { stdout } = await runCli(["module", "index", "--root", root, "--repository", "https://github.com/example/keel-modules"]);
  assert.match(stdout, /2 modules, 2 verified/u);

  const catalog = JSON.parse(await readFile(path.join(root, "catalog/catalog.json"), "utf8"));
  assert.equal(catalog.schema, "keel-module-catalog@3");
  // A flat workspace with keel.jsmodule@1 manifests still indexes: it simply
  // declares no publisher, so the listing axes are null rather than absent.
  assert.deepEqual(catalog.publishers, []);
  assert.deepEqual(catalog.modules.map((entry) => entry.id), ["adder", "greeter"]);
  const greeter = catalog.modules[1];
  assert.equal(greeter.version, "0.1.0");
  assert.equal(greeter.license, "MIT");
  assert.equal(greeter.summary, "Greets by name.");
  assert.equal(greeter.sourceRepository, "https://github.com/example/keel-modules");
  assert.equal(greeter.githubPath, "modules/greeter/src/index.ts");
  assert.equal(greeter.disposition, "reproducible-build");
  assert.equal(greeter.verified, true);
  assert.equal(greeter.publisher, null);
  assert.equal(greeter.category, null);
  assert.equal(greeter.owner, null);
  assert.equal(greeter.moduleRepository, null);
  // Verified is a claim about bytes and says nothing about chains.
  assert.deepEqual(greeter.deployments, []);
  assert.equal(greeter.deployed, false);
  assert.match(greeter.outputDigest, /^0x[0-9a-f]{64}$/u);
  assert.match(greeter.receiptDigest, /^0x[0-9a-f]{64}$/u);

  // sourceFiles are the READABLE files, digested exactly as they sit in the repo.
  assert.equal(greeter.sourceFiles.length, 1);
  assert.equal(greeter.sourceFiles[0].path, "modules/greeter/src/index.ts");
  const sourceIntegrity = await createIntegrity(new Uint8Array(await readFile(path.join(root, "modules/greeter/src/index.ts"))));
  assert.equal(greeter.sourceFiles[0].sha256, sourceIntegrity.digest);

  // Stale dist bytes are refused rather than catalogued.
  await writeFile(path.join(root, "modules/greeter/dist/greeter.min.js"), "export const tampered = true;\n");
  await assert.rejects(() => runCli(["module", "index", "--root", root]), /no longer match/u);
});

/**
 * A publisher is a person or an organisation. Requiring somebody to invent an
 * org before they can publish a module would be a made-up hurdle, so a user
 * owns modules directly and has no groups.
 */
async function scaffoldPublisherWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "keel-publisher-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "tsconfig.base.json"), BASE_TSCONFIG);

  const publishers = [
    {
      id: "acme",
      manifest: {
        schema: "keel.publisher@1", kind: "org", id: "acme", title: "Acme",
        summary: "An organisation.", url: "https://github.com/acme", identityId: null,
        members: [{ id: "dana", name: "Dana", role: "owner", github: "dana", address: null }],
        groups: [{ id: "tools", title: "Tools", summary: "Tooling.", members: ["dana"] }],
      },
    },
    {
      id: "solo",
      manifest: {
        schema: "keel.publisher@1", kind: "user", id: "solo", title: "Solo Dev",
        summary: "One person, no org.", url: "https://github.com/solo", identityId: null,
        members: [], groups: [],
      },
    },
  ];
  for (const publisher of publishers) {
    await mkdir(path.join(root, "modules", publisher.id), { recursive: true });
    await writeFile(path.join(root, "modules", publisher.id, "publisher.json"), `${JSON.stringify(publisher.manifest, null, 2)}\n`);
  }

  const modules = [
    { id: "adder", publisher: "acme", category: "math", owner: { org: "acme", group: "tools", member: "dana" }, source: ADDER_SOURCE },
    { id: "greeter", publisher: "solo", category: "text", owner: { user: "solo" }, source: GREETER_SOURCE },
  ];
  for (const module of modules) {
    const directory = path.join(root, "modules", module.publisher, module.category, module.id);
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(
      path.join(directory, "keel.module.json"),
      `${JSON.stringify({
        schema: "keel.jsmodule@2", id: module.id, entry: "src/index.ts", license: "MIT",
        summary: `${module.id} module.`, category: module.category, owner: module.owner,
      }, null, 2)}\n`,
    );
    await writeFile(path.join(directory, "tsconfig.json"), `${JSON.stringify({ extends: "../../../../tsconfig.base.json", include: ["src"] }, null, 2)}\n`);
    await writeFile(path.join(directory, "src/index.ts"), module.source);
  }
  return root;
}

test("a person can publish a module without inventing an organisation", async (t) => {
  const root = await scaffoldPublisherWorkspace(t);
  await runCli(["module", "build", "--all", "--root", root]);
  const { stdout } = await runCli(["module", "index", "--root", root, "--repository", "https://github.com/example/modules"]);
  assert.match(stdout, /2 modules, 2 verified/u);

  const catalog = JSON.parse(await readFile(path.join(root, "catalog/catalog.json"), "utf8"));
  assert.equal(catalog.schema, "keel-module-catalog@3");
  assert.deepEqual(catalog.publishers.map((publisher) => [publisher.id, publisher.kind]), [["acme", "org"], ["solo", "user"]]);

  // The user owns its module directly: no group, no member, no ceremony.
  const greeter = catalog.modules.find((module) => module.id === "greeter");
  assert.deepEqual(greeter.owner, { publisher: "solo", kind: "user", group: null, member: null });
  assert.equal(greeter.publisher, "solo");
  assert.equal(greeter.category, "text");

  // The org keeps the longer path available.
  const adder = catalog.modules.find((module) => module.id === "adder");
  assert.deepEqual(adder.owner, { publisher: "acme", kind: "org", group: "tools", member: "dana" });

  // A user publisher has no groups to list under.
  assert.deepEqual(catalog.publishers.find((publisher) => publisher.id === "solo").groups, []);
});

test("an owner that cannot be rendered is refused rather than guessed at", async (t) => {
  const root = await scaffoldPublisherWorkspace(t);
  const manifestPath = path.join(root, "modules/solo/text/greeter/keel.module.json");
  const original = JSON.parse(await readFile(manifestPath, "utf8"));

  const rejected = [
    // A person is not an org with one member, so a user has no groups.
    [{ ...original, owner: { user: "solo", group: "tools" } }, /belong to an org/u],
    // "Who owns this" is the question being asked; two answers is worse than none.
    [{ ...original, owner: { user: "solo", org: "acme" } }, /must name one/u],
    // org > member > module has no way back up to a group.
    [{ ...original, owner: { org: "acme", member: "dana" } }, /requires owner\.group/u],
    // Claiming a person is an org would render the wrong listing shape.
    [{ ...original, owner: { org: "solo" } }, /declared as a user/u],
    [{ ...original, owner: { user: "nobody" } }, /has no publisher\.json/u],
  ];
  for (const [manifest, expected] of rejected) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      () => runCli(["module", "build", "--all", "--root", root]).then(() => runCli(["module", "index", "--root", root])),
      expected,
      `expected ${JSON.stringify(manifest.owner)} to be refused`,
    );
  }
});
