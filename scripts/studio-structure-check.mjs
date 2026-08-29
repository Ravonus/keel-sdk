import { execFileSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { root, siteRoot } from "./run.mjs";

const studio = path.join(siteRoot, "apps", "studio");

async function loadTypeScript() {
  try {
    return await import("typescript");
  } catch {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const require = createRequire(import.meta.url);
    return require(path.join(globalRoot, "typescript", "lib", "typescript.js"));
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const values = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) values.push(...(await walk(absolute)));
    else values.push(absolute);
  }
  return values;
}

function importCandidates(file, specifier) {
  const base = specifier.startsWith("~/")
    ? path.join(studio, "src", specifier.slice(2))
    : path.resolve(path.dirname(file), specifier);
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
}

const required = [
  "package.json",
  "tsconfig.json",
  "drizzle.config.ts",
  "drizzle/0000_initial.sql",
  "drizzle/0001_keel_contract_kinds.sql",
  "drizzle/0002_library_index.sql",
  "drizzle/0003_source_verification_queue.sql",
  "src/app/create/page.tsx",
  "src/app/artifacts/page.tsx",
  "src/app/artifacts/[artifactId]/page.tsx",
  "src/app/collect/page.tsx",
  "src/app/collect/[chainId]/[collection]/[tokenId]/page.tsx",
  "src/app/indexer/page.tsx",
  "src/app/launch/page.tsx",
  "src/app/system/page.tsx",
  "src/app/keel/page.tsx",
  "src/app/api/keel/read/[chainId]/[address]/route.ts",
  "src/server/db/schema.ts",
  "src/server/services/artifact-service.ts",
  "src/server/services/collector-service.ts",
  "src/server/services/publication-service.ts",
  "src/server/indexer/indexer-service.ts",
  "src/server/security/write-access.ts",
  "src/stores/upload-store.ts",
  "scripts/deploy-local.ts",
];
await Promise.all(required.map((relative) => access(path.join(studio, relative))));

const ts = await loadTypeScript();
const sourceFiles = [
  ...(await walk(path.join(studio, "src"))),
  path.join(studio, "playwright.config.ts"),
].filter((file) => /\.tsx?$/u.test(file));
let issueCount = 0;
for (const file of sourceFiles) {
  const source = await readFile(file, "utf8");
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  for (const diagnostic of parsed.parseDiagnostics) {
    console.error(`TypeScript parse error in ${path.relative(root, file)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    issueCount += 1;
  }
  const imports = [];
  const collect = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    ts.forEachChild(node, collect);
  };
  collect(parsed);
  for (const specifier of imports) {
    if (!specifier.startsWith("~/") && !specifier.startsWith("./") && !specifier.startsWith("../")) continue;
    const candidates = importCandidates(file, specifier);
    let found = false;
    for (const candidate of candidates) {
      try {
        await access(candidate);
        found = true;
        break;
      } catch {
        // Try the next supported TypeScript module path.
      }
    }
    if (!found) {
      console.error(`Missing local import in ${path.relative(root, file)}: ${specifier}`);
      issueCount += 1;
    }
  }
}

const schema = await readFile(path.join(studio, "src/server/db/schema.ts"), "utf8");
const migrationDirectory = path.join(studio, "drizzle");
const migrationFiles = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
const migration = (await Promise.all(migrationFiles.map((name) => readFile(path.join(migrationDirectory, name), "utf8")))).join("\n");
const tableNames = [...schema.matchAll(/pgTable\(\s*["']([^"']+)["']/gu)].map((match) => match[1]);
for (const table of tableNames) {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? "${escaped}"`, "u").test(migration)) {
    console.error(`Drizzle migration is missing table ${table}.`);
    issueCount += 1;
  }
}
const enumNames = [...schema.matchAll(/pgEnum\(\s*["']([^"']+)["']/gu)].map((match) => match[1]);
for (const enumName of enumNames) {
  if (!migration.includes(`CREATE TYPE "${enumName}" AS ENUM`)) {
    console.error(`Drizzle migration is missing enum ${enumName}.`);
    issueCount += 1;
  }
}

const protectedPostRoutes = new Map([
  ["src/app/api/artifacts/route.ts", ["assertSameOriginRequest(request.headers)", "resolveArtifactCreator(request"]],
  ["src/app/api/artifacts/import/route.ts", ["assertStudioWriteAccess(request.headers)"]],
  ["src/app/api/deployment/[artifactId]/complete/route.ts", ["assertArtifactPublicationAccess(request, artifactId)"]],
  ["src/app/api/indexer/run/route.ts", ["assertStudioWriteAccess(request.headers)"]],
]);
for (const [relative, requiredGuards] of protectedPostRoutes) {
  const source = await readFile(path.join(studio, relative), "utf8");
  if (!requiredGuards.every((guard) => source.includes(guard))) {
    console.error(`Mutating route ${relative} is missing its expected write or creator guard.`);
    issueCount += 1;
  }
}
for (const relative of [
  "src/app/api/onchain/[chainId]/[store]/[objectId]/route.ts",
  "src/app/api/presentation/[chainId]/[registry]/[collection]/[tokenId]/route.ts",
  "src/app/api/contract-call/[chainId]/[to]/route.ts",
  "src/app/api/keel/read/[chainId]/[address]/route.ts",
]) {
  const source = await readFile(path.join(studio, relative), "utf8");
  if (!source.includes("chainContracts") || !source.includes("eq(chainContracts.enabled, true)")) {
    console.error(`Verified gateway ${relative} does not enforce the configured-contract allowlist.`);
    issueCount += 1;
  }
}

const keelGateway = await readFile(
  path.join(studio, "src/app/api/keel/read/[chainId]/[address]/route.ts"),
  "utf8",
);
if (!keelGateway.includes("configured.functions.has(body.functionName)")) {
  console.error("Keel browser gateway does not enforce its view-function allowlist.");
  issueCount += 1;
}


const routerFiles = (await walk(path.join(studio, "src/server/api/routers"))).filter((file) => file.endsWith(".ts"));
for (const file of routerFiles) {
  const source = await readFile(file, "utf8");
  const mutationCount = (source.match(/\.mutation\s*\(/gu) ?? []).length;
  const writeOccurrences = (source.match(/writeProcedure/gu) ?? []).length;
  const operatorOccurrences = (source.match(/operatorProcedure/gu) ?? []).length;
  const protectedCount = Math.max(0, writeOccurrences - 1) + Math.max(0, operatorOccurrences - 1);
  if (mutationCount > protectedCount) {
    console.error(`Mutating tRPC procedure in ${path.relative(root, file)} may bypass writeProcedure.`);
    issueCount += 1;
  }
}

const packageJson = JSON.parse(await readFile(path.join(studio, "package.json"), "utf8"));
if (packageJson.version !== "0.3.0") {
  console.error("Studio package version must match release 0.3.0.");
  issueCount += 1;
}
if (packageJson.dependencies?.zustand === undefined || packageJson.dependencies?.["drizzle-orm"] === undefined) {
  console.error("Studio must retain Zustand and Drizzle dependencies.");
  issueCount += 1;
}

if (issueCount > 0) process.exit(1);
console.log(
  `Studio structure passed: ${sourceFiles.length} TypeScript files parsed, local imports resolve, migration covers ${tableNames.length} tables, and write/gateway guards are present.`,
);
