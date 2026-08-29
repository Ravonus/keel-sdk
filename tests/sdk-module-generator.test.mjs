import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SDK_ROOT = path.join(ROOT, "packages", "sdk");
const BUILDER_DIST = path.join(ROOT, "packages", "builder", "dist", "index.js");

function documentModuleSource(name, options = {}) {
  const { imports = [], render = "" } = options;
  return [
    'import { defineDocument, defineModule } from "@keel/sdk/module";',
    ...imports,
    `const root = defineModule(${JSON.stringify(name)}, {`,
    '  target: "@keel/eth/sepolia", extends: [],',
    `  document: defineDocument({ title: ${JSON.stringify(name)}, render({ root }) { ${render} } }),`,
    '});',
    'export default root;',
  ].join("\n");
}

test("arbitrary TypeScript entries generate executable HTML, shared chunks, and an offline publication plan", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-creator-build-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    await mkdir(path.join(fixture, "shared"), { recursive: true });
    await mkdir(path.join(fixture, "line"), { recursive: true });
    await mkdir(path.join(fixture, "cool-s"), { recursive: true });
    await writeFile(path.join(fixture, "shared", "style.css"), ".shared{color:rgb(1 2 3)}\n");
    await writeFile(path.join(fixture, "shared", "render.ts"), [
      'import "./style.css";',
      'globalThis.__keelImportedCreatorMetadataExecuted = true;',
      'export function render(root: HTMLElement, label: string) { root.className = "shared"; root.textContent = label; }',
    ].join("\n"));
    const entry = (label) => [
      'import { defineDocument, defineModule } from "@keel/sdk/module";',
      'import { render } from "../shared/render.js";',
      'globalThis.__keelCreatorMetadataExecuted = true;',
      `const root = defineModule(${JSON.stringify(label)}, {`,
      '  target: "@keel/eth/sepolia", extends: [],',
      `  document: defineDocument({ title: ${JSON.stringify(label)}, render({ root }) { render(root, ${JSON.stringify(label)}); } }),`,
      '  init() { globalThis.__keelInitCalls = (globalThis.__keelInitCalls ?? 0) + 1; },',
      '});',
      'export default root;',
    ].join("\n");
    await writeFile(path.join(fixture, "line", "anything.creator.ts"), entry("LINE"));
    await writeFile(path.join(fixture, "cool-s", "main-app.ts"), entry("Cool S"));
    await writeFile(path.join(fixture, "sandbox.ts"), entry("Sandbox").replace('../shared/render.js', './shared/render.js'));
    await writeFile(path.join(fixture, "missing-document.ts"), [
      'import { defineModule } from "@keel/sdk/module";',
      'export default defineModule("Missing", { target: "@keel/eth/sepolia", extends: [] });',
    ].join("\n"));

    const outputDirectory = path.join(fixture, "dist");
    const { buildCreatorProject } = await import(pathToFileURL(BUILDER_DIST).href);
    await assert.rejects(() => buildCreatorProject({
      root: fixture,
      outputDirectory: path.join(fixture, "bad-dist"),
      surfaces: [{ name: "missing", entry: "missing-document.ts", isolation: "sandbox" }],
    }), /must declare document/u);
    await assert.rejects(() => buildCreatorProject({
      root: path.join(fixture, "line"),
      outputDirectory: path.join(fixture, "escape-dist"),
      surfaces: [{ name: "escape", entry: "../sandbox.ts", isolation: "sandbox" }],
    }), /stay inside/u);
    const plan = await buildCreatorProject({
      root: fixture,
      outputDirectory,
      sharedRoots: ["shared"],
      surfaces: [
        { name: "line", entry: "line/anything.creator.ts", isolation: "shared-library" },
        { name: "cool-s", entry: "cool-s/main-app.ts", isolation: "shared-library" },
        { name: "sandbox", entry: "sandbox.ts", sourceRoot: "sandbox.ts", isolation: "sandbox" },
      ],
    });
    assert.equal(globalThis.__keelInitCalls, undefined, "build-time document discovery must not execute init");
    assert.equal(globalThis.__keelCreatorMetadataExecuted, undefined, "static metadata discovery must not execute top-level creator code");
    assert.equal(globalThis.__keelImportedCreatorMetadataExecuted, undefined, "static metadata discovery must not execute imported creator code");

    for (const file of ["line.html", "cool-s.html", "sandbox.html"]) {
      const source = await readFile(path.join(outputDirectory, file), "utf8");
      assert.match(source, /^<!doctype html>/u);
      assert.match(source, /<script type="module" src="\.\//u);
      assert.match(source, /<title>(?:LINE|Cool S|Sandbox)<\/title>/u);
      assert.doesNotMatch(source, /node:|child_process|worker_threads/u);
    }
    for (const node of plan.nodes.filter((candidate) => candidate.mediaType === "text/javascript")) {
      const source = await readFile(path.join(outputDirectory, node.file), "utf8");
      assert.doesNotMatch(source, /node:|child_process|worker_threads|verification-shell/u);
    }
    const sharedFiles = await readdir(path.join(outputDirectory, "library", "shared"));
    assert.ok(sharedFiles.some((file) => file.endsWith(".js")), "library surfaces must emit their shared TS module once");
    const libraryFiles = await readdir(path.join(outputDirectory, "library"), { recursive: true });
    assert.equal(libraryFiles.filter((file) => file.endsWith(".css")).length, 1, "library surfaces must emit their shared CSS once");
    assert.equal(plan.schema, "keel-creator-publication-plan@1");
    assert.ok(plan.nodes.every((node) => node.objectId === null && node.integrity.algorithm === "sha256" && /^0x[0-9a-f]{64}$/u.test(node.integrity.digest)));
    assert.ok(plan.edges.every((edge) => edge.publishResolution === "object-id-from-receipt"));
    const planNodeKeys = new Set(plan.nodes.map((node) => node.key));
    assert.ok(plan.edges.every((edge) => planNodeKeys.has(edge.consumer) && planNodeKeys.has(edge.dependency)), "every generated output edge must resolve to a generated node");
    assert.ok(plan.surfaces.some((surface) => surface.isolation === "sandbox"));
    assert.deepEqual(JSON.parse(await readFile(path.join(outputDirectory, "keel-publication-plan.json"), "utf8")), plan);

    /* A reduced rebuild removes only the exact old tool outputs listed in the
     * marker; it never treats the output directory itself as disposable. */
    await writeFile(path.join(outputDirectory, "keep.txt"), "not tool owned\n");
    const reducedPlan = await buildCreatorProject({
      root: fixture,
      outputDirectory,
      sharedRoots: ["shared"],
      surfaces: [{ name: "line", entry: "line/anything.creator.ts", isolation: "shared-library" }],
    });
    await assert.rejects(readFile(path.join(outputDirectory, "cool-s.html"), "utf8"), /ENOENT/u);
    await assert.rejects(readFile(path.join(outputDirectory, "sandbox.html"), "utf8"), /ENOENT/u);
    const currentFiles = new Set(reducedPlan.nodes.map((node) => node.file));
    for (const staleFile of plan.nodes.map((node) => node.file).filter((file) => !currentFiles.has(file))) {
      await assert.rejects(readFile(path.join(outputDirectory, staleFile), "utf8"), /ENOENT/u, `stale tool output ${staleFile} must be removed`);
    }
    assert.equal(await readFile(path.join(outputDirectory, "keep.txt"), "utf8"), "not tool owned\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("generated grouped publication edges name their emitted bytes and advance through receipt-bound stages", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-creator-publication-edges-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    await mkdir(path.join(fixture, "shared"), { recursive: true });
    await mkdir(path.join(fixture, "line"), { recursive: true });
    await mkdir(path.join(fixture, "cool-s"), { recursive: true });
    await writeFile(path.join(fixture, "shared", "scene.ts"), 'export const sceneName = "shared scene";\n');
    const entry = (name) => documentModuleSource(name, {
      imports: ['import { sceneName } from "../shared/scene.js";'],
      render: "root.textContent = sceneName;",
    });
    await writeFile(path.join(fixture, "line", "line.ts"), entry("LINE"));
    await writeFile(path.join(fixture, "cool-s", "cool-s.ts"), entry("Cool S"));

    const { advanceCreatorPublication, buildCreatorProject, prepareCreatorPublicationFromDirectory } = await import(pathToFileURL(BUILDER_DIST).href);
    const outputDirectory = path.join(fixture, "dist");
    const plan = await buildCreatorProject({
      root: fixture,
      outputDirectory,
      sharedRoots: ["shared"],
      surfaces: [
        { name: "line", entry: "line/line.ts", isolation: "shared-library" },
        { name: "cool-s", entry: "cool-s/cool-s.ts", isolation: "shared-library" },
      ],
    });
    assert.ok(plan.edges.some((edge) => edge.consumer === "object:library/cool-s.js" && edge.dependency.startsWith("object:library/shared/")),
      "the Cool S entry must retain its emitted shared dependency edge");
    for (const edge of plan.edges) {
      const consumer = plan.nodes.find((node) => node.key === edge.consumer);
      assert.ok(consumer, `edge consumer ${edge.consumer} must be a generated node`);
      const consumerText = await readFile(path.join(outputDirectory, consumer.file), "utf8");
      assert.match(edge.localSpecifier, /^\.\.?(?:\/)/u, "generated dependencies must use a browser-relative specifier");
      assert.equal(consumerText.split(edge.localSpecifier).length - 1, 1,
        `${edge.consumer} must contain exactly one dependency token for ${edge.localSpecifier}`);
      assert.doesNotMatch(edge.localSpecifier, /(?:^|\/)dist\/creator\//u,
        "publication edges must not use esbuild's project-relative metafile path");
    }

    const prepared = await prepareCreatorPublicationFromDirectory(plan, outputDirectory);
    const receipts = [];
    let nextObjectId = 1;
    let previousStage = -1;
    let sawDependencySubstitution = false;
    for (;;) {
      const advance = await advanceCreatorPublication(prepared, receipts);
      if (advance.readyStage === null) break;
      assert.ok(advance.readyStage.index > previousStage, "staged publication advances strictly from leaves toward roots");
      previousStage = advance.readyStage.index;
      for (const ready of advance.ready) {
        if (prepared.edges.some((edge) => edge.consumer === ready.key)) {
          const preparedText = new TextDecoder().decode(ready.preparedBytes);
          assert.match(preparedText, /keel:\/\/creator\/[0-9a-f]{64}/u,
            "a parent stage must substitute receipt-bound aliases into its exact emitted import");
          sawDependencySubstitution = true;
        }
        receipts.push({
          nodeKey: ready.key,
          originalIntegrity: ready.originalIntegrity,
          preparedIntegrity: ready.preparedIntegrity,
          byteLength: ready.preparedBytes.byteLength,
          mediaType: ready.mediaType,
          objectId: `0x${(nextObjectId++).toString(16).padStart(64, "0")}`,
          evidence: { status: "accepted", reference: "synthetic-regression-receipt" },
        });
      }
    }
    assert.ok(sawDependencySubstitution, "the generated graph must make progress beyond its leaf stage");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("child scopes inherit APIs through type-only parent imports and reject runtime collisions", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-scope-types-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    await writeFile(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(path.join(fixture, "descriptors.ts"), [
      'import { browserModule, moduleApi, solidityCapability } from "@keel/sdk/module";',
      'export interface Harness { readOutput(name: string): Promise<unknown>; }',
      'export interface Story { advance(value: string): void; }',
      'export const harness = solidityCapability("keel-harness", { as: "harness", api: moduleApi<Harness>() });',
      'export const story = browserModule("story", { as: "story", api: moduleApi<Story>() });',
      'export const ROOT_EXTENDS = [harness] as const;',
    ].join("\n"));
    await writeFile(path.join(fixture, "entry-any-name.ts"), [
      'import { connectChildScopes, defineModule, type DeclaredModule } from "@keel/sdk/module";',
      'import { ROOT_EXTENDS } from "./descriptors.js";',
      'import { child } from "./feature.js";',
      'export const root: DeclaredModule<typeof ROOT_EXTENDS> = defineModule("Root", { target: "@keel/eth/sepolia", extends: ROOT_EXTENDS });',
      'export default connectChildScopes(root, [child]);',
    ].join("\n"));
    await writeFile(path.join(fixture, "feature.ts"), [
      'import { defineChildScope, parentScope } from "@keel/sdk/module";',
      'import { story } from "./descriptors.js";',
      'import type { root } from "./entry-any-name.js";',
      'export const child = defineChildScope("Feature", {',
      '  parent: parentScope<typeof root>("Root"), extends: [story],',
      '  async init({ harness, story }) {',
      '    story.advance(String(await harness.readOutput("door")));',
      '    // @ts-expect-error unrelated APIs do not leak into this scope.',
      '    harness.missing();',
      '  },',
      '});',
    ].join("\n"));
    await writeFile(path.join(fixture, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true },
      include: ["*.ts"],
    }));
    const tsc = path.join(ROOT, "node_modules", ".bin", "tsc");
    const result = spawnSync(tsc, ["-p", path.join(fixture, "tsconfig.json")], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const { browserModule, connectChildScopes, defineChildScope, defineDocument, defineModule, moduleApi, parentScope, solidityCapability } =
      await import(pathToFileURL(path.join(SDK_ROOT, "dist", "module", "index.js")).href);
    const harness = solidityCapability("keel-harness", { as: "api", api: moduleApi() });
    const document = defineDocument({
      title: "Runtime root",
      render() {},
    });
    const root = defineModule("Runtime root", { target: "@keel/eth/sepolia", extends: [harness], document });
    const connected = connectChildScopes(root, []);
    assert.equal(connected.document, document, "a connected default remains mountable as its parent declaration");
    assert.equal(connected.module, root, "child metadata retains the original declaration identity");
    const conflicting = defineChildScope("Conflict", {
      parent: parentScope("Runtime root"),
      extends: [browserModule("local", { as: "api", api: moduleApi() })],
    });
    assert.throws(() => connectChildScopes(root, [conflicting]), /conflicts with inherited API name api/u);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a connectChildScopes default export builds as a browser declaration", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-connected-default-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    await writeFile(path.join(fixture, "connected.ts"), [
      'import { connectChildScopes, defineDocument, defineModule } from "@keel/sdk/module";',
      'import { child } from "./child.js";',
      'const root = defineModule("Connected", {',
      '  target: "@keel/eth/sepolia", extends: [],',
      '  document: defineDocument({ title: "Connected", render({ root }) { root.textContent = "ready"; } }),',
      '});',
      'export default connectChildScopes(root, [child]);',
    ].join("\n"));
    await writeFile(path.join(fixture, "child.ts"), [
      'import { defineChildScope, parentScope } from "@keel/sdk/module";',
      'export const child = defineChildScope("Connected child", { parent: parentScope("Connected"), extends: [] });',
    ].join("\n"));
    const { buildCreatorProject } = await import(pathToFileURL(BUILDER_DIST).href);
    const outputDirectory = path.join(fixture, "dist");
    const plan = await buildCreatorProject({
      root: fixture,
      outputDirectory,
      surfaces: [{ name: "connected", entry: "connected.ts", isolation: "sandbox" }],
    });
    assert.equal(plan.surfaces[0]?.entry, "sandbox/connected/connected.js");
    assert.match(await readFile(path.join(outputDirectory, "connected.html"), "utf8"), /<title>Connected<\/title>/u);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("creator document metadata requires trusted named SDK imports and accepts aliases", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-creator-metadata-imports-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    const { buildCreatorProject } = await import(pathToFileURL(BUILDER_DIST).href);

    await writeFile(path.join(fixture, "aliases.ts"), [
      'import { connectChildScopes as connect, defineDocument as document, defineModule as module, trustedHtml as html } from "@keel/sdk/module";',
      'const root = module("Aliases", {',
      '  target: "@keel/eth/sepolia", extends: [],',
      '  document: document({ title: "Aliases", head: html("<meta name=\\"creator\\" content=\\"alias\\">"), render({ root }) { root.textContent = "ready"; } }),',
      '});',
      'export default connect(root, []);',
    ].join("\n"));
    const aliases = await buildCreatorProject({
      root: fixture,
      outputDirectory: path.join(fixture, "aliases-dist"),
      surfaces: [{ name: "aliases", entry: "aliases.ts", isolation: "sandbox" }],
    });
    assert.equal(aliases.surfaces[0]?.html, "aliases.html");
    assert.match(await readFile(path.join(fixture, "aliases-dist", "aliases.html"), "utf8"), /name="creator" content="alias"/u);

    await writeFile(path.join(fixture, "local-trusted-html.ts"), [
      'import { defineDocument, defineModule } from "@keel/sdk/module";',
      'const trustedHtml = (value) => value;',
      'const root = defineModule("Local head", {',
      '  target: "@keel/eth/sepolia", extends: [],',
      '  document: defineDocument({ title: "Local head", head: trustedHtml("<meta name=\\"local\\">"), render() {} }),',
      '});',
      'export default root;',
    ].join("\n"));
    await assert.rejects(
      () => buildCreatorProject({
        root: fixture,
        outputDirectory: path.join(fixture, "local-head-dist"),
        surfaces: [{ name: "local-head", entry: "local-trusted-html.ts", isolation: "sandbox" }],
      }),
      /head must be created with trustedHtml/u,
    );

    await writeFile(path.join(fixture, "foreign-module.ts"), [
      'import { defineDocument, defineModule } from "not-the-keel-sdk";',
      'const root = defineModule("Foreign", {',
      '  target: "@keel/eth/sepolia", extends: [],',
      '  document: defineDocument({ title: "Foreign", render() {} }),',
      '});',
      'export default root;',
    ].join("\n"));
    await assert.rejects(
      () => buildCreatorProject({
        root: fixture,
        outputDirectory: path.join(fixture, "foreign-module-dist"),
        surfaces: [{ name: "foreign-module", entry: "foreign-module.ts", isolation: "sandbox" }],
      }),
      /must resolve to defineModule/u,
    );

    await writeFile(path.join(fixture, "type-only-module.ts"), [
      'import type { defineDocument, defineModule } from "@keel/sdk/module";',
      'const root = defineModule("Type only", {',
      '  target: "@keel/eth/sepolia", extends: [],',
      '  document: defineDocument({ title: "Type only", render() {} }),',
      '});',
      'export default root;',
    ].join("\n"));
    await assert.rejects(
      () => buildCreatorProject({
        root: fixture,
        outputDirectory: path.join(fixture, "type-only-module-dist"),
        surfaces: [{ name: "type-only-module", entry: "type-only-module.ts", isolation: "sandbox" }],
      }),
      /must resolve to defineModule/u,
    );

    await writeFile(path.join(fixture, "foreign-trusted-html.ts"), [
      'import { defineDocument, defineModule } from "@keel/sdk/module";',
      'import { trustedHtml } from "not-the-keel-sdk";',
      'const root = defineModule("Foreign head", {',
      '  target: "@keel/eth/sepolia", extends: [],',
      '  document: defineDocument({ title: "Foreign head", head: trustedHtml("<meta name=\\"foreign\\">"), render() {} }),',
      '});',
      'export default root;',
    ].join("\n"));
    await assert.rejects(
      () => buildCreatorProject({
        root: fixture,
        outputDirectory: path.join(fixture, "foreign-head-dist"),
        surfaces: [{ name: "foreign-head", entry: "foreign-trusted-html.ts", isolation: "sandbox" }],
      }),
      /head must be created with trustedHtml/u,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("creator output cleanup rejects symlinked marker parents and targets before deletion", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-creator-output-links-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "keel-creator-output-victim-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    await writeFile(path.join(fixture, "entry.ts"), documentModuleSource("Cleanup"));
    const { buildCreatorProject } = await import(pathToFileURL(BUILDER_DIST).href);
    const outputDirectory = path.join(fixture, "dist");
    const markerPath = path.join(outputDirectory, ".keel-creator-output.json");
    const options = {
      root: fixture,
      outputDirectory,
      surfaces: [{ name: "cleanup", entry: "entry.ts", isolation: "sandbox" }],
    };
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outside, "victim.txt"), "outside must survive\n");

    const parentMarker = `${JSON.stringify({ schema: "keel-creator-output@1", files: ["linked-parent/victim.txt"] }, null, 2)}\n`;
    await symlink(outside, path.join(outputDirectory, "linked-parent"), "dir");
    await writeFile(markerPath, parentMarker);
    await assert.rejects(() => buildCreatorProject(options), /symbolic link/u);
    assert.equal(await readFile(path.join(outside, "victim.txt"), "utf8"), "outside must survive\n");
    assert.equal(await readFile(markerPath, "utf8"), parentMarker, "failed cleanup preserves its marker");

    await rm(path.join(outputDirectory, "linked-parent"), { recursive: true, force: true });
    const targetMarker = `${JSON.stringify({ schema: "keel-creator-output@1", files: ["linked-target.txt"] }, null, 2)}\n`;
    await symlink(path.join(outside, "victim.txt"), path.join(outputDirectory, "linked-target.txt"), "file");
    await writeFile(markerPath, targetMarker);
    await assert.rejects(() => buildCreatorProject(options), /symbolic link/u);
    assert.equal(await readFile(path.join(outside, "victim.txt"), "utf8"), "outside must survive\n");
    assert.equal(await readFile(markerPath, "utf8"), targetMarker, "failed cleanup preserves its marker");
  } finally {
    await Promise.all([
      rm(fixture, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("creator output accepts a direct external directory and rejects a symlink output root without touching its target", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-creator-output-policy-"));
  const externalOutput = await mkdtemp(path.join(os.tmpdir(), "keel-creator-direct-output-"));
  const symlinkTarget = await mkdtemp(path.join(os.tmpdir(), "keel-creator-linked-target-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    await writeFile(path.join(fixture, "entry.ts"), documentModuleSource("Output policy"));
    const { buildCreatorProject } = await import(pathToFileURL(BUILDER_DIST).href);
    const surface = [{ name: "policy", entry: "entry.ts", isolation: "sandbox" }];

    const directPlan = await buildCreatorProject({ root: fixture, outputDirectory: externalOutput, surfaces: surface });
    assert.equal(directPlan.surfaces[0].html, "policy.html");
    assert.match(await readFile(path.join(externalOutput, "policy.html"), "utf8"), /^<!doctype html>/u);

    await writeFile(path.join(symlinkTarget, "sentinel.txt"), "preserve target\n");
    const linkedOutput = path.join(fixture, "linked-output");
    await symlink(symlinkTarget, linkedOutput, "dir");
    await assert.rejects(
      () => buildCreatorProject({ root: fixture, outputDirectory: linkedOutput, surfaces: surface }),
      /outputDirectory itself must not be a symbolic link/u,
    );
    assert.deepEqual(await readdir(symlinkTarget), ["sentinel.txt"]);
    assert.equal(await readFile(path.join(symlinkTarget, "sentinel.txt"), "utf8"), "preserve target\n");
  } finally {
    await Promise.all([
      rm(fixture, { recursive: true, force: true }),
      rm(externalOutput, { recursive: true, force: true }),
      rm(symlinkTarget, { recursive: true, force: true }),
    ]);
  }
});

test("creator build rejects nested output symlinks before library, sandbox, or shared writes", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-creator-nested-output-links-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "keel-creator-nested-output-victim-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    await mkdir(path.join(fixture, "library"), { recursive: true });
    await mkdir(path.join(fixture, "sandbox"), { recursive: true });
    await writeFile(path.join(fixture, "library", "entry.ts"), documentModuleSource("Library"));
    await writeFile(path.join(fixture, "sandbox", "entry.ts"), documentModuleSource("Sandbox"));
    await writeFile(path.join(outside, "sentinel.txt"), "never write through output links\n");
    const { buildCreatorProject } = await import(pathToFileURL(BUILDER_DIST).href);
    const outputDirectory = path.join(fixture, "dist");
    const options = {
      root: fixture,
      outputDirectory,
      surfaces: [
        { name: "library", entry: "library/entry.ts", isolation: "shared-library" },
        { name: "sandbox", entry: "sandbox/entry.ts", isolation: "sandbox" },
      ],
    };
    for (const nested of ["library", "sandbox", "library/shared"]) {
      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(path.dirname(path.join(outputDirectory, nested)), { recursive: true });
      await symlink(outside, path.join(outputDirectory, nested), "dir");
      await assert.rejects(() => buildCreatorProject(options), /symbolic link/u, `must reject ${nested}`);
      assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "never write through output links\n");
    }
  } finally {
    await Promise.all([
      rm(fixture, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("creator entry and source boundaries reject symlink escapes and cross-sandbox private imports", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-creator-boundaries-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "keel-creator-outside-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    const { buildCreatorProject } = await import(pathToFileURL(BUILDER_DIST).href);

    await writeFile(path.join(outside, "outside-entry.ts"), documentModuleSource("Outside"));
    await symlink(path.join(outside, "outside-entry.ts"), path.join(fixture, "linked-entry.ts"));
    await assert.rejects(
      () => buildCreatorProject({
        root: fixture,
        outputDirectory: path.join(fixture, "entry-dist"),
        surfaces: [{ name: "linked", entry: "linked-entry.ts", isolation: "sandbox" }],
      }),
      /escapes the creator root through a symlink/u,
    );

    await mkdir(path.join(fixture, "source"), { recursive: true });
    await writeFile(path.join(outside, "private.ts"), 'export const privateValue = "outside";\n');
    await symlink(path.join(outside, "private.ts"), path.join(fixture, "source", "linked.ts"));
    await writeFile(path.join(fixture, "source", "entry.ts"), documentModuleSource("Source", {
      imports: ['import { privateValue } from "./linked.js";'],
      render: "root.textContent = privateValue;",
    }));
    await assert.rejects(
      () => buildCreatorProject({
        root: fixture,
        outputDirectory: path.join(fixture, "source-dist"),
        surfaces: [{ name: "source", entry: "source/entry.ts", isolation: "sandbox" }],
      }),
      /escapes the creator root through a symlink/u,
    );

    await mkdir(path.join(fixture, "sandbox-a"), { recursive: true });
    await mkdir(path.join(fixture, "sandbox-b"), { recursive: true });
    await writeFile(path.join(fixture, "sandbox-a", "entry.ts"), documentModuleSource("A", {
      imports: ['import { privateValue } from "../sandbox-b/private.js";'],
      render: "root.textContent = privateValue;",
    }));
    await writeFile(path.join(fixture, "sandbox-b", "entry.ts"), documentModuleSource("B"));
    await writeFile(path.join(fixture, "sandbox-b", "private.ts"), 'export const privateValue = "private";\n');
    await assert.rejects(
      () => buildCreatorProject({
        root: fixture,
        outputDirectory: path.join(fixture, "sandbox-dist"),
        surfaces: [
          { name: "sandbox-a", entry: "sandbox-a/entry.ts", isolation: "sandbox" },
          { name: "sandbox-b", entry: "sandbox-b/entry.ts", isolation: "sandbox" },
        ],
      }),
      /surface sandbox-a may not import private source/u,
    );
  } finally {
    await Promise.all([
      rm(fixture, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
