#!/usr/bin/env node
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, createSourceReceipt, parseArtifactManifest, validateManifest, type Compression, type Hex } from "@keel/protocol";
import { createUploadPlan } from "./plan.js";
import { lockModuleSnapshotFile, moduleSpecifierFromFlags, resolveModuleSnapshotFile } from "./module-cli.js";
import { buildKeelModule, initKeelModule, planKeelModule } from "./module-pipeline.js";
import { testKeelModule, verifyKeelModuleCandidate } from "./module-testing.js";
import { buildKeelWorkspace, indexKeelWorkspace, testKeelWorkspace, verifyKeelWorkspaceRegistrations } from "./module-workspace.js";
import { registerKeelModuleFromOrigin } from "./module-registration.js";
import { verifyKeelModuleFromOrigin } from "./module-verification.js";
import { analyzeCost } from "./cost-analysis.js";
import { analyzeMedia, runMediaPipeline, verifyBuiltArtifact } from "./pipeline.js";
import { createRecursiveUploadPlan } from "./recursive-plan.js";
import { wrapImage } from "./wrap.js";

interface ParsedArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index] ?? "";
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, positional, flags };
}

function flag(args: ParsedArguments, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

function required(value: string | undefined, message: string): string {
  if (value === undefined || value.length === 0) throw new TypeError(message);
  return value;
}

function output(value: unknown, json: boolean, summary: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${summary}\n`);
}

const MAX_COST_INPUT_BYTES = 256 * 1024 * 1024;

async function readCostInput(filePath: string): Promise<Uint8Array> {
  const requested = path.resolve(filePath);
  const entries = await readdir(path.dirname(requested), { withFileTypes: true });
  const entry = entries.find((item) => item.name === path.basename(requested));
  if (entry === undefined || !entry.isFile() || entry.isSymbolicLink()) throw new TypeError("cost input must be a regular non-symlink file.");
  const resolved = await realpath(requested);
  const before = await stat(resolved);
  if (!before.isFile() || before.size <= 0 || before.size > MAX_COST_INPUT_BYTES) throw new RangeError(`cost input must be from 1 through ${MAX_COST_INPUT_BYTES} bytes.`);
  const bytes = new Uint8Array(await readFile(resolved));
  const secondRead = new Uint8Array(await readFile(resolved));
  const after = await stat(resolved);
  const stable = bytes.byteLength === secondRead.byteLength && bytes.every((value, index) => value === secondRead[index]);
  if (!stable || bytes.byteLength !== before.size || bytes.byteLength !== after.size || (await realpath(requested)) !== resolved) throw new Error("cost input changed while it was being read.");
  return bytes;
}

function usage(): string {
  return `Keel builder (bin: keel; oca remains as a compatibility alias)

Commands:
  keel module init <dir> [--name <name>]
  keel module build <dir> [--keep-comments] [--stamp <file>] [--no-compact] [--json]
  keel module build --all [--root <workspace>] [--keep-comments] [--stamp <file>] [--json]
  keel module test <dir> [--json]
  keel module test --all [--root <workspace>] [--json]
  keel module compact <dir> --candidate <file> [--json]
  keel module index [--root <workspace>] [--repository <url>] [--json]
  keel module verify --repo <owner/name> --commit <sha> [--path <dir>] [--entry src/index.ts]
    [--expect <0xdigest>] [--no-compact] [--json]
  keel module verify --all [--root <workspace>] [--json]
  keel module register --repo <owner/name> --commit <sha> --out <dir> [--path <dir>]
    [--entry src/index.ts] [--id <id>] [--category <name>] [--owner-user <handle>]
    [--owner-org <id>] [--owner-group <id>] [--owner-member <id>] [--license MIT]
    [--summary <text>] [--version 0.1.0] [--json]
  keel module plan <dir> [--chain-id 11155111] [--address <0x...>] [--json]
  keel analyze <input> [--media-type <type>] [--json]
  keel build <input> --out <directory> --created-at <ISO date> [--name <name>] [--description <text>]
    [--id <id>] [--quality 82] [--creator <value>] [--source-repository <value>]
    [--viewer-base-url <url>] [--inline] [--no-original] [--json]
  keel verify <release-directory> [--manifest <file-name>] [--json]
  keel cost <input> [--media-type <type>] [--compression auto|none|brotli|gzip|deflate]
    [--chunk-bytes 23000] [--leaf-bytes 524288] [--parts 64] [--max-depth 8] [--json]
  keel module-resolve <snapshot.json> (--name <name> | --digest <0xsha256> --byte-length <n>)
    [--namespace npm|keel|github] [--version <version>] [--entry <path>]
    [--artist <artist>] [--tag <a,b>] [--json]
  keel module-lock <snapshot.json> --out <lock.json> (--name <name> | --digest <0xsha256> --byte-length <n>)
    [--namespace npm|keel|github] [--version <version>] [--entry <path>]
    [--artist <artist>] [--tag <a,b>] [--json]
  keel wrap-image <input> --out <directory> [--name <name>] [--description <text>] [--id <id>]
    [--quality 82] [--creator <value>] [--source-repository <value>] [--viewer-base-url <url>]
    [--inline] [--no-original]
  keel chunk <input> --out <directory> --media-type <type> [--compression auto|brotli|gzip|deflate|none] [--chunk-bytes 23000]
  keel chunk-recursive <input> --out <directory> --media-type <type> [--leaf-bytes 524288] [--parts 64]
  keel audit <manifest.json>
  keel canonicalize <manifest.json> [--out <file>]
  keel source-verify <source> [--output <published-file>] --media-type <type>
    [--repository <url> --revision <commit-or-tag> --source-path <path>]
    [--build-recipe-digest <bytes32>] [--out <receipt.json>]
`;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  switch (args.command) {
    case "module-resolve": {
      const snapshotPath = required(args.positional[0], "module-resolve requires a snapshot file.");
      const selector = moduleSpecifierFromFlags(args.flags);
      const result = await resolveModuleSnapshotFile(snapshotPath, selector);
      output(result, args.flags.json === true, result.status === "resolved"
        ? `Resolved ${result.releaseKey}; bytes=${result.bytes}.`
        : `${result.status}: ${result.message}`);
      if (result.status !== "resolved") process.exitCode = 1;
      return;
    }

    case "module-lock": {
      const snapshotPath = required(args.positional[0], "module-lock requires a snapshot file.");
      const outputPath = required(flag(args, "out"), "module-lock requires --out.");
      const selector = moduleSpecifierFromFlags(args.flags);
      const result = await lockModuleSnapshotFile(snapshotPath, outputPath, selector);
      output(result, args.flags.json === true, `Wrote ${result.lockPath} and ${result.receiptPath}; bytes=unavailable.`);
      return;
    }

    case "module": {
      const verb = required(args.positional[0], "module requires a subcommand: init, build, test, compact, verify, register, index, or plan.");
      const all = args.flags.all === true && (verb === "build" || verb === "test" || verb === "verify");
      const workspaceRoot = flag(args, "root") ?? process.cwd();
      const directory = verb === "index" || verb === "verify" || verb === "register" || all
        ? undefined
        : required(args.positional[1], `module ${verb} requires a module directory (or --all).`);
      if (verb === "init") {
        const name = flag(args, "name");
        const result = await initKeelModule(directory as string, name === undefined ? {} : { name });
        output(result, args.flags.json === true, `Scaffolded ${result.manifest.name} in ${result.directory}: ${result.files.join(", ")}.`);
        return;
      }
      if (verb === "build") {
        const stampPath = flag(args, "stamp");
        const buildOptions = {
          ...(args.flags["no-compact"] === true ? { compact: false } : {}),
          ...(args.flags["keep-comments"] === true ? { keepComments: true } : {}),
          ...(stampPath === undefined ? {} : { stampPath }),
        };
        if (all) {
          const results = await buildKeelWorkspace(workspaceRoot, buildOptions);
          output(
            results,
            args.flags.json === true,
            results
              .map((entry) => `Built ${entry.module.workspacePath} (${entry.build.outputIntegrity.byteLength} bytes; ${entry.build.receipt.disposition}).`)
              .join("\n"),
          );
          return;
        }
        const result = await buildKeelModule(directory as string, buildOptions);
        const compactLine = result.recipe.compact === undefined
          ? ""
          : `compact winner: ${result.recipe.compact.winner} (esbuild ${result.recipe.compact.candidateBytes.esbuild} bytes, terser ${result.recipe.compact.candidateBytes.terser} bytes)\n`;
        output(
          result,
          args.flags.json === true,
          `Built ${result.outputPath} (${result.outputIntegrity.byteLength} bytes; ${result.receipt.disposition}).\n` +
          compactLine +
          `source digest:  ${result.receipt.source.digest}\n` +
          `output digest:  ${result.receipt.output.digest}\n` +
          `receipt digest: ${result.receiptDigest}`,
        );
        return;
      }
      if (verb === "test") {
        if (all) {
          const results = await testKeelWorkspace(workspaceRoot);
          const lines = results.map((entry) => entry.test === undefined
            ? `${entry.module.workspacePath}: skipped (no ${"test/vectors.mjs"})`
            : `${entry.module.workspacePath}: ${entry.test.passed ? "passed" : "FAILED"} (${entry.test.vectors.length} vectors)`);
          const failed = results.some((entry) => entry.test !== undefined && !entry.test.passed);
          output(results, args.flags.json === true, lines.join("\n"));
          if (failed) process.exitCode = 1;
          return;
        }
        const result = await testKeelModule(directory as string);
        output(
          result,
          args.flags.json === true,
          `${result.manifest.name}: ${result.passed ? "passed" : "FAILED"}; shipped bytes match the readable source on ` +
          `${result.vectors.filter((vector) => vector.matchesSource).length}/${result.vectors.length} vectors.`,
        );
        if (!result.passed) process.exitCode = 1;
        return;
      }
      if (verb === "compact") {
        const candidate = required(flag(args, "candidate"), "module compact requires --candidate <file>.");
        const result = await verifyKeelModuleCandidate(directory as string, candidate);
        output(
          result,
          args.flags.json === true,
          `Candidate ${result.candidatePath} (${result.candidateByteLength} bytes) matched the readable source on all ` +
          `${result.vectors.length} vectors.\nWrote ${result.receiptPath} (${result.receipt.disposition}; receipt digest ${result.receiptDigest}).\n` +
          `Trust order reminder: reproducible-build > behaviorally-verified.`,
        );
        return;
      }
      if (verb === "verify" && all) {
        const results = await verifyKeelWorkspaceRegistrations(workspaceRoot);
        const failed = results.filter((result) => !result.reproduced);
        output(
          results,
          args.flags.json === true,
          results.length === 0
            ? "No origin registrations in this workspace."
            : results
                .map((result) => result.reproduced
                  ? `${result.registration.id}: reproduced from ${result.registration.origin.owner}/${result.registration.origin.repo}@${result.registration.origin.commit.slice(0, 10)}`
                  : `${result.registration.id}: DRIFTED\n  ${result.mismatches.join("\n  ")}`)
                .join("\n"),
        );
        if (failed.length > 0) process.exitCode = 1;
        return;
      }
      if (verb === "register") {
        const repository = required(flag(args, "repo"), "module register requires --repo <owner/name>.");
        const [owner, name] = repository.split("/");
        if (owner === undefined || name === undefined || name.length === 0) throw new TypeError("--repo must be <owner>/<name>.");
        const commit = required(flag(args, "commit"), "module register requires --commit <sha>.");
        const outDirectory = required(flag(args, "out"), "module register requires --out <dir>, where the registration is written.");
        const recipeRoot = flag(args, "path");
        const entry = flag(args, "entry") ?? "src/index.ts";
        const ownerUser = flag(args, "owner-user");
        const ownerOrg = flag(args, "owner-org");
        if ((ownerUser === undefined) === (ownerOrg === undefined)) throw new TypeError("Provide exactly one of --owner-user or --owner-org.");
        const ownerGroup = flag(args, "owner-group");
        const ownerMember = flag(args, "owner-member");
        const result = await registerKeelModuleFromOrigin({
          origin: {
            provider: "github",
            owner,
            repo: name,
            commit,
            ...(recipeRoot === undefined ? {} : { path: recipeRoot }),
            entry,
          },
          id: flag(args, "id") ?? name,
          version: flag(args, "version") ?? "0.1.0",
          license: flag(args, "license") ?? "MIT",
          summary: flag(args, "summary") ?? `${flag(args, "id") ?? name}: a Keel module.`,
          category: flag(args, "category") ?? "uncategorised",
          owner: ownerUser === undefined
            ? { org: ownerOrg as string, ...(ownerGroup === undefined ? {} : { group: ownerGroup }), ...(ownerMember === undefined ? {} : { member: ownerMember }) }
            : { user: ownerUser },
          outDirectory,
        });
        output(
          result,
          args.flags.json === true,
          `Wrote ${result.path}\n` +
          `verified:       ${owner}/${name}@${commit.slice(0, 10)}\n` +
          `output digest:  ${result.registration.expect.outputDigest}\n` +
          `receipt digest: ${result.registration.expect.receiptDigest}\n` +
          "Commit this file. Indexing reads it offline; \"keel module verify --all\" re-checks it over the network.",
        );
        return;
      }
      if (verb === "verify") {
        const repository = required(flag(args, "repo"), "module verify requires --repo <owner/name>.");
        const [owner, name] = repository.split("/");
        if (owner === undefined || name === undefined || name.length === 0) throw new TypeError("--repo must be <owner>/<name>.");
        const commit = required(flag(args, "commit"), "module verify requires --commit <sha>; a branch moves and a proof pinned to it expires silently.");
        const recipeRoot = flag(args, "path");
        const entry = flag(args, "entry") ?? "src/index.ts";
        const expected = flag(args, "expect");
        if (expected !== undefined && !/^0x[0-9a-f]{64}$/u.test(expected)) throw new TypeError("--expect must be a lower-case sha256 digest.");
        const verified = await verifyKeelModuleFromOrigin({
          origin: { protocol: "keel-source-origin@1", provider: "github", owner, repo: name, commit, visibility: "public" },
          identity: { namespace: "keel", name, version: "0.0.0", entry },
          entry,
          ...(recipeRoot === undefined ? {} : { recipeRoot }),
          ...(args.flags["no-compact"] === true ? {} : { compact: { keepComments: false } }),
          mediaType: "text/javascript",
        });
        const digest = verified.recipe.output.integrity.digest;
        const matches = expected === undefined || digest === expected;
        output(
          { ...verified, outputBytes: undefined, matchesExpected: matches },
          args.flags.json === true,
          `${repository}@${commit.slice(0, 10)}${recipeRoot === undefined ? "" : `/${recipeRoot}`}\n` +
          `verdict:        ${verified.verification.verdict} (${verified.receipt.disposition})\n` +
          `source digest:  ${verified.receipt.source.digest}\n` +
          `output digest:  ${digest}\n` +
          `archive digest: ${verified.archiveIntegrity.digest}\n` +
          (expected === undefined
            ? "No --expect given, so this is a reproduction, not a comparison."
            : matches
              ? `Matches --expect: the published bytes are this source.`
              : `DOES NOT MATCH --expect ${expected}.`),
        );
        if (!matches || !verified.verification.reproduced) process.exitCode = 1;
        return;
      }
      if (verb === "index") {
        const repositoryUrl = flag(args, "repository");
        const result = await indexKeelWorkspace(workspaceRoot, repositoryUrl === undefined ? {} : { repositoryUrl });
        output(
          result,
          args.flags.json === true,
          `Wrote ${result.catalogPath}: ${result.catalog.modules.length} modules, ` +
          `${result.catalog.modules.filter((entry) => entry.verified).length} verified.`,
        );
        return;
      }
      if (verb === "plan") {
        const chainIdValue = flag(args, "chain-id");
        const chainId = chainIdValue === undefined ? undefined : Number(chainIdValue);
        if (chainId !== undefined && (!Number.isSafeInteger(chainId) || chainId <= 0)) throw new RangeError("--chain-id must be a positive safe integer.");
        const address = flag(args, "address");
        if (address !== undefined && !/^0x[0-9a-f]{40}$/u.test(address)) throw new TypeError("--address must be a lower-case 20-byte Ethereum address.");
        const result = await planKeelModule(directory as string, {
          ...(chainId === undefined ? {} : { chainId }),
          ...(address === undefined ? {} : { address: address as `0x${string}` }),
        });
        output(
          result,
          args.flags.json === true,
          `Wrote ${result.planPath} (review-only; ${result.envelope.plan.operationCount} operations; plan digest ${result.envelope.integrity.digest}).`,
        );
        return;
      }
      throw new TypeError(`Unknown module subcommand ${verb}. Use init, build, test, compact, verify, register, index, or plan.`);
    }

    case "analyze": {
      const input = required(args.positional[0], "analyze requires an input file.");
      const mediaType = flag(args, "media-type");
      const analysis = await analyzeMedia({ input, ...(mediaType === undefined ? {} : { mediaType }) });
      output(analysis, args.flags.json === true, `${analysis.input.fileName}: ${analysis.input.mediaType}, ${analysis.input.byteLength} bytes; wrapper=${analysis.wrapper.strategy}.`);
      return;
    }

    case "build": {
      const input = required(args.positional[0], "build requires an input file.");
      const outputDirectory = required(flag(args, "out"), "build requires --out.");
      const createdAt = required(flag(args, "created-at"), "build requires --created-at for reproducible output.");
      const quality = flag(args, "quality");
      const name = flag(args, "name");
      const description = flag(args, "description");
      const id = flag(args, "id");
      const creator = flag(args, "creator");
      const sourceRepository = flag(args, "source-repository");
      const viewerBaseUrl = flag(args, "viewer-base-url");
      const result = await runMediaPipeline({
        input,
        outputDirectory,
        createdAt,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(id === undefined ? {} : { id }),
        ...(creator === undefined ? {} : { creator }),
        ...(sourceRepository === undefined ? {} : { sourceRepository }),
        ...(viewerBaseUrl === undefined ? {} : { viewerBaseUrl }),
        ...(quality === undefined ? {} : { webpQuality: Number(quality) }),
        sourceMode: args.flags.inline === true ? "inline" : "files",
        preserveOriginal: args.flags["no-original"] !== true,
      });
      output(result, args.flags.json === true, `Built ${result.build.output.manifestPath}; verification=${result.valid ? "passed" : "failed"}.`);
      if (!result.valid) process.exitCode = 1;
      return;
    }

    case "verify": {
      const directory = required(args.positional[0], "verify requires a release directory.");
      const manifestName = flag(args, "manifest");
      const result = await verifyBuiltArtifact({ directory, ...(manifestName === undefined ? {} : { manifestName }) });
      output(result, args.flags.json === true, `Verified ${result.manifestPath}; status=${result.valid ? "valid" : "invalid"}.`);
      if (!result.valid) process.exitCode = 1;
      return;
    }

    case "cost": {
      const input = required(args.positional[0], "cost requires an input file.");
      const compression = flag(args, "compression") as Compression | "auto" | undefined;
      const mediaType = flag(args, "media-type");
      const chunkBytes = flag(args, "chunk-bytes");
      const leafBytes = flag(args, "leaf-bytes");
      const parts = flag(args, "parts");
      const maxDepth = flag(args, "max-depth");
      const analysis = await analyzeCost(await readCostInput(input), {
        ...(compression === undefined ? {} : { compression }),
        ...(mediaType === undefined ? {} : { mediaType }),
        ...(chunkBytes === undefined ? {} : { maxChunkBytes: Number(chunkBytes) }),
        ...(leafBytes === undefined ? {} : { leafDecodedBytes: Number(leafBytes) }),
        ...(parts === undefined ? {} : { maxPartsPerComposite: Number(parts) }),
        ...(maxDepth === undefined ? {} : { maxTreeDepth: Number(maxDepth) }),
      });
      const recommendation = analysis.recommendation;
      output(
        analysis,
        args.flags.json === true,
        `${analysis.inputByteLength} bytes; compression=${analysis.selectedCompression}; strategy=${recommendation.strategy}; ` +
        `transactions=${recommendation.transactionCount}; calldata=${recommendation.calldataBytes} bytes (modeled estimate, not a gas quote).`,
      );
      return;
    }

    case "wrap-image": {
      const input = required(args.positional[0], "wrap-image requires an input file.");
      const outputDirectory = required(flag(args, "out"), "wrap-image requires --out.");
      const quality = flag(args, "quality");
      const name = flag(args, "name");
      const description = flag(args, "description");
      const id = flag(args, "id");
      const creator = flag(args, "creator");
      const sourceRepository = flag(args, "source-repository");
      const viewerBaseUrl = flag(args, "viewer-base-url");
      const output = await wrapImage({
        input,
        outputDirectory,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(id === undefined ? {} : { id }),
        ...(creator === undefined ? {} : { creator }),
        ...(sourceRepository === undefined ? {} : { sourceRepository }),
        ...(viewerBaseUrl === undefined ? {} : { viewerBaseUrl }),
        ...(quality === undefined ? {} : { webpQuality: Number(quality) }),
        sourceMode: args.flags.inline === true ? "inline" : "files",
        preserveOriginal: args.flags["no-original"] !== true,
      });
      process.stdout.write(`${output.manifestPath}\n`);
      return;
    }

    case "chunk": {
      const input = required(args.positional[0], "chunk requires an input file.");
      const outputDirectory = required(flag(args, "out"), "chunk requires --out.");
      const mediaType = required(flag(args, "media-type"), "chunk requires --media-type.");
      const compression = (flag(args, "compression") ?? "auto") as Compression | "auto";
      const bytes = new Uint8Array(await readFile(path.resolve(input)));
      const plan = await createUploadPlan(bytes, {
        objectName: path.basename(input),
        mediaType,
        outputDirectory,
        compression,
        ...(flag(args, "chunk-bytes") === undefined ? {} : { maxChunkBytes: Number(flag(args, "chunk-bytes")) }),
      });
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return;
    }

    case "chunk-recursive": {
      const input = required(args.positional[0], "chunk-recursive requires an input file.");
      const outputDirectory = required(flag(args, "out"), "chunk-recursive requires --out.");
      const mediaType = required(flag(args, "media-type"), "chunk-recursive requires --media-type.");
      const compression = (flag(args, "compression") ?? "auto") as Compression | "auto";
      const bytes = new Uint8Array(await readFile(path.resolve(input)));
      const plan = await createRecursiveUploadPlan(bytes, {
        objectName: path.basename(input),
        mediaType,
        outputDirectory,
        compression,
        ...(flag(args, "chunk-bytes") === undefined ? {} : { maxChunkBytes: Number(flag(args, "chunk-bytes")) }),
        ...(flag(args, "leaf-bytes") === undefined ? {} : { leafDecodedBytes: Number(flag(args, "leaf-bytes")) }),
        ...(flag(args, "parts") === undefined ? {} : { maxPartsPerComposite: Number(flag(args, "parts")) }),
      });
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return;
    }

    case "audit": {
      const input = required(args.positional[0], "audit requires a manifest file.");
      const manifest = parseArtifactManifest(JSON.parse((await readFile(path.resolve(input))).toString("utf8")) as unknown);
      const result = validateManifest(manifest);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.valid) process.exitCode = 1;
      return;
    }

    case "canonicalize": {
      const input = required(args.positional[0], "canonicalize requires a manifest file.");
      const manifest = parseArtifactManifest(JSON.parse((await readFile(path.resolve(input))).toString("utf8")) as unknown);
      const output = `${canonicalJson(manifest)}\n`;
      const outputFile = flag(args, "out");
      if (outputFile === undefined) process.stdout.write(output);
      else await writeFile(path.resolve(outputFile), output);
      return;
    }

    case "source-verify": {
      const sourcePath = required(args.positional[0], "source-verify requires a readable source file.");
      const outputPath = flag(args, "output") ?? sourcePath;
      const mediaType = required(flag(args, "media-type"), "source-verify requires --media-type.");
      const repository = flag(args, "repository");
      const revision = flag(args, "revision");
      const repositoryPath = flag(args, "source-path");
      if ([repository, revision, repositoryPath].filter((value) => value !== undefined).length !== 0 &&
          (repository === undefined || revision === undefined || repositoryPath === undefined)) {
        throw new TypeError("Repository verification requires --repository, --revision, and --source-path together.");
      }
      const receipt = await createSourceReceipt({
        sourceBytes: new Uint8Array(await readFile(path.resolve(sourcePath))),
        outputBytes: new Uint8Array(await readFile(path.resolve(outputPath))),
        mediaType,
        ...(repository === undefined ? {} : { repository: { url: repository, revision: revision!, path: repositoryPath! } }),
        ...(flag(args, "build-recipe-digest") === undefined ? {} : { buildRecipeDigest: flag(args, "build-recipe-digest") as Hex }),
      });
      const serialized = `${canonicalJson(receipt)}\n`;
      const receiptPath = flag(args, "out");
      if (receiptPath === undefined) process.stdout.write(serialized);
      else await writeFile(path.resolve(receiptPath), serialized);
      return;
    }

    case "help":
    case "--help":
    case "-h":
      process.stdout.write(usage());
      return;

    default:
      process.stderr.write(`Unknown command ${args.command}.\n\n${usage()}`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
