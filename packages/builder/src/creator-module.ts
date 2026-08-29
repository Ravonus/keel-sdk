import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { build, type BuildResult, type Metafile, type Plugin } from "esbuild";
import { createIntegrity, type Hex, type Integrity } from "@keel/protocol";
import * as ts from "typescript";

const require = createRequire(import.meta.url);
const utilTypes = (require("node:util") as { readonly types: { isProxy(value: unknown): boolean } }).types;

export type CreatorSurfaceIsolation = "shared-library" | "sandbox";

export interface CreatorSurface {
  readonly name: string;
  /** Arbitrary TypeScript entry path, relative to root. */
  readonly entry: string;
  /**
   * Private source boundary for this surface, relative to root. Omit it for
   * the entry's directory; declare it explicitly when sibling surfaces share
   * that directory.
   */
  readonly sourceRoot?: string;
  readonly isolation: CreatorSurfaceIsolation;
}

export interface CreatorObjectNode {
  readonly key: string;
  readonly file: string;
  readonly mediaType: string;
  readonly integrity: Integrity;
  /** Assigned by publication from the integrity-bound object receipt. */
  readonly objectId: null;
}

export interface CreatorObjectEdge {
  readonly consumer: string;
  readonly dependency: string;
  readonly localSpecifier: string;
  readonly publishResolution: "object-id-from-receipt";
}

export interface CreatorPublicationPlan {
  readonly schema: "keel-creator-publication-plan@1";
  readonly nodes: readonly CreatorObjectNode[];
  readonly edges: readonly CreatorObjectEdge[];
  readonly surfaces: readonly Readonly<{
    name: string;
    isolation: CreatorSurfaceIsolation;
    html: string;
    entry: string;
  }>[];
}

export interface BuildCreatorProjectOptions {
  readonly root: string;
  readonly outputDirectory: string;
  readonly surfaces: readonly CreatorSurface[];
  /** Source directories deliberately shared by otherwise-private surfaces. */
  readonly sharedRoots?: readonly string[];
}

function safeName(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]*$/u.test(value)) {
    throw new TypeError(`surface name ${JSON.stringify(value)} must be lowercase and filename-safe.`);
  }
  return value;
}

function mediaType(file: string): string {
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

interface DiscoveredDocument {
  readonly title: string;
  readonly lang: string;
  readonly mountId: string;
  readonly head?: string;
}

function escaped(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function html(document: DiscoveredDocument, scriptSpecifier: string, cssSpecifiers: readonly string[]): string {
  const links = cssSpecifiers.map((specifier) => `  <link rel="stylesheet" href="${specifier}">`).join("\n");
  return `<!doctype html>\n<html lang="${escaped(document.lang)}">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n  <title>${escaped(document.title)}</title>\n${links}${links === "" ? "" : "\n"}${document.head ?? ""}</head>\n<body>\n  <div id="${escaped(document.mountId)}"></div>\n  <script type="module" src="${scriptSpecifier}"></script>\n</body>\n</html>\n`;
}

function outputRelative(outputDirectory: string, output: string): string {
  return path.relative(outputDirectory, path.resolve(output)).split(path.sep).join("/");
}

/**
 * A publication edge is later substituted in the consumer's emitted bytes.
 * Derive its specifier from the two emitted output paths rather than esbuild's
 * metafile path, which can be rooted at the project directory rather than the
 * importing output file.
 */
function emittedOutputSpecifier(consumerFile: string, dependencyFile: string): string {
  const from = consumerFile.split("/");
  from.pop();
  const to = dependencyFile.split("/");
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  const relative = [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
  if (relative === "" || relative === ".") {
    throw new TypeError(`creator output ${consumerFile} cannot import itself.`);
  }
  return relative === ".." || relative.startsWith("../") ? relative : `./${relative}`;
}

function rawOutputPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function canonicalOutputImport(
  root: string,
  outputDirectory: string,
  importer: string,
  imported: string,
  byRawPath: ReadonlyMap<string, string>,
  byAbsolutePath: ReadonlyMap<string, string>,
): string {
  const exact = byRawPath.get(rawOutputPath(imported));
  if (exact !== undefined) return exact;
  const candidates = [
    path.resolve(root, imported),
    path.resolve(outputDirectory, imported),
    path.resolve(path.dirname(path.resolve(root, importer)), imported),
  ];
  for (const candidate of candidates) {
    const resolved = byAbsolutePath.get(candidate);
    if (resolved !== undefined) return resolved;
  }
  throw new TypeError(`creator output import ${JSON.stringify(imported)} from ${JSON.stringify(importer)} does not name a generated output.`);
}

interface PreparedSurface {
  readonly surface: CreatorSurface;
  readonly entry: string;
  readonly sourceRoot: string;
  readonly document: DiscoveredDocument;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".css"] as const;

function isInside(container: string, candidate: string): boolean {
  const relative = path.relative(container, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalInside(root: string, candidate: string, description: string): Promise<string> {
  const lexical = path.resolve(candidate);
  if (!isInside(root, lexical)) throw new TypeError(`${description} must stay inside the creator root.`);
  let resolved: string;
  try {
    resolved = await realpath(lexical);
  } catch {
    throw new TypeError(`${description} must name an existing file or directory inside the creator root.`);
  }
  if (!isInside(root, resolved)) throw new TypeError(`${description} escapes the creator root through a symlink.`);
  return resolved;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!("name" in property) || property.name === undefined) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
  return undefined;
}

function propertyValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (propertyName(property) === name && ts.isPropertyAssignment(property)) return property.initializer;
  }
  return undefined;
}

function hasProperty(object: ts.ObjectLiteralExpression, name: string): boolean {
  return object.properties.some((property) => propertyName(property) === name);
}

const MODULE_HELPERS = ["connectChildScopes", "defineDocument", "defineModule", "trustedHtml"] as const;
type ModuleHelper = (typeof MODULE_HELPERS)[number];

function trustedModuleImports(file: ts.SourceFile): ReadonlyMap<string, ModuleHelper> {
  const bindings = new Map<string, ModuleHelper>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@keel/sdk/module") continue;
    if (statement.importClause?.isTypeOnly) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const binding of named.elements) {
      if (binding.isTypeOnly) continue;
      const imported = (binding.propertyName ?? binding.name).text;
      if (!(MODULE_HELPERS as readonly string[]).includes(imported)) continue;
      const helper = imported as ModuleHelper;
      const previous = bindings.get(binding.name.text);
      if (previous !== undefined && previous !== helper) {
        throw new TypeError(`module helper import ${binding.name.text} has conflicting provenance.`);
      }
      bindings.set(binding.name.text, helper);
    }
  }
  return bindings;
}

function isTrustedModuleCall(expression: ts.Expression, helper: ModuleHelper, imports: ReadonlyMap<string, ModuleHelper>): boolean {
  return ts.isIdentifier(expression) && imports.get(expression.text) === helper;
}

function staticBindings(file: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) bindings.set(declaration.name.text, declaration.initializer);
    }
  }
  return bindings;
}

function resolveStaticExpression(expression: ts.Expression, bindings: ReadonlyMap<string, ts.Expression>, seen = new Set<string>()): ts.Expression {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return resolveStaticExpression(expression.expression, bindings, seen);
  }
  if (!ts.isIdentifier(expression)) return expression;
  if (seen.has(expression.text)) throw new TypeError(`cyclic metadata binding ${expression.text}.`);
  const bound = bindings.get(expression.text);
  if (bound === undefined) return expression;
  seen.add(expression.text);
  return resolveStaticExpression(bound, bindings, seen);
}

function staticString(expression: ts.Expression | undefined, bindings: ReadonlyMap<string, ts.Expression>, description: string): string {
  if (expression === undefined) throw new TypeError(`${description} must be a static string.`);
  const resolved = resolveStaticExpression(expression, bindings);
  if (!ts.isStringLiteral(resolved) && !ts.isNoSubstitutionTemplateLiteral(resolved)) {
    throw new TypeError(`${description} must be a static string.`);
  }
  return resolved.text;
}

function scriptKind(entry: string): ts.ScriptKind {
  switch (path.extname(entry).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

/**
 * Metadata is parsed from the declaration AST, never evaluated. A creator's
 * top-level code belongs to its browser entry, not to the build machine.
 */
function discoverStaticDocument(entry: string, surface: CreatorSurface): DiscoveredDocument {
  const source = ts.sys.readFile(entry);
  if (source === undefined) throw new TypeError(`surface ${surface.name} entry could not be read.`);
  const file = ts.createSourceFile(entry, source, ts.ScriptTarget.ES2022, true, scriptKind(entry));
  const defaults = file.statements.filter(ts.isExportAssignment).filter((statement) => !statement.isExportEquals);
  if (defaults.length !== 1) {
    throw new TypeError(`surface ${surface.name} must have exactly one default module document export.`);
  }
  const bindings = staticBindings(file);
  const imports = trustedModuleImports(file);
  let moduleExpression = resolveStaticExpression((defaults[0] as ts.ExportAssignment).expression, bindings);
  while (ts.isCallExpression(moduleExpression) && isTrustedModuleCall(moduleExpression.expression, "connectChildScopes", imports)) {
    const parent = moduleExpression.arguments[0];
    if (parent === undefined) throw new TypeError(`surface ${surface.name} connectChildScopes() needs a parent module.`);
    moduleExpression = resolveStaticExpression(parent, bindings);
  }
  if (!ts.isCallExpression(moduleExpression) || !isTrustedModuleCall(moduleExpression.expression, "defineModule", imports)) {
    throw new TypeError(`surface ${surface.name} default export must resolve to defineModule().`);
  }
  const moduleInput = moduleExpression.arguments[1] === undefined
    ? undefined
    : resolveStaticExpression(moduleExpression.arguments[1], bindings);
  if (moduleInput === undefined || !ts.isObjectLiteralExpression(moduleInput)) {
    throw new TypeError(`surface ${surface.name} defineModule() must declare document.`);
  }
  const documentExpression = propertyValue(moduleInput, "document");
  if (documentExpression === undefined) throw new TypeError(`surface ${surface.name} defineModule() must declare document.`);
  const documentCall = resolveStaticExpression(documentExpression, bindings);
  if (!ts.isCallExpression(documentCall) || !isTrustedModuleCall(documentCall.expression, "defineDocument", imports)) {
    throw new TypeError(`surface ${surface.name} document must be created with defineDocument().`);
  }
  const documentInput = documentCall.arguments[0] === undefined
    ? undefined
    : resolveStaticExpression(documentCall.arguments[0], bindings);
  if (documentInput === undefined || !ts.isObjectLiteralExpression(documentInput)) {
    throw new TypeError(`surface ${surface.name} defineDocument() needs a static object literal.`);
  }
  if (!hasProperty(documentInput, "render")) {
    throw new TypeError(`surface ${surface.name} defineDocument() must declare render.`);
  }
  const title = staticString(propertyValue(documentInput, "title"), bindings, `surface ${surface.name} document title`);
  const lang = propertyValue(documentInput, "lang") === undefined
    ? "en"
    : staticString(propertyValue(documentInput, "lang"), bindings, `surface ${surface.name} document lang`);
  const mountId = propertyValue(documentInput, "mountId") === undefined
    ? "app"
    : staticString(propertyValue(documentInput, "mountId"), bindings, `surface ${surface.name} document mountId`);
  if (title.trim() === "" || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(lang) || !/^[A-Za-z][A-Za-z0-9_:-]*$/u.test(mountId)) {
    throw new TypeError(`surface ${surface.name} has an invalid static module document.`);
  }
  const headExpression = propertyValue(documentInput, "head");
  let head: string | undefined;
  if (headExpression !== undefined) {
    const headCall = resolveStaticExpression(headExpression, bindings);
    if (!ts.isCallExpression(headCall) || !isTrustedModuleCall(headCall.expression, "trustedHtml", imports)) {
      throw new TypeError(`surface ${surface.name} document head must be created with trustedHtml().`);
    }
    head = staticString(headCall.arguments[0], bindings, `surface ${surface.name} document head`);
    if (head.trim() === "") throw new TypeError(`surface ${surface.name} document head must be nonempty.`);
  }
  return { title, lang, mountId, ...(head === undefined ? {} : { head }) };
}

async function resolveEntry(root: string, surface: CreatorSurface): Promise<string> {
  return canonicalInside(root, path.resolve(root, surface.entry), `surface ${surface.name} entry`);
}

async function resolveSurfaceRoot(root: string, surface: CreatorSurface, entry: string): Promise<string> {
  const candidate = surface.sourceRoot === undefined ? path.dirname(entry) : path.resolve(root, surface.sourceRoot);
  const sourceRoot = await canonicalInside(root, candidate, `surface ${surface.name} sourceRoot`);
  if (!isInside(sourceRoot, entry)) throw new TypeError(`surface ${surface.name} sourceRoot must contain its entry.`);
  return sourceRoot;
}

async function resolveSharedRoots(root: string, sharedRoots: readonly string[] | undefined): Promise<readonly string[]> {
  const roots: string[] = [];
  for (const sharedRoot of sharedRoots ?? []) {
    if (typeof sharedRoot !== "string" || sharedRoot.trim() === "") throw new TypeError("sharedRoots entries must be nonempty paths.");
    const resolved = await canonicalInside(root, path.resolve(root, sharedRoot), `sharedRoot ${JSON.stringify(sharedRoot)}`);
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return Object.freeze(roots.sort());
}

function assertDisjointRoots(surfaces: readonly PreparedSurface[], sharedRoots: readonly string[]): void {
  for (const surface of surfaces) {
    for (const sharedRoot of sharedRoots) {
      if (isInside(surface.sourceRoot, sharedRoot) || isInside(sharedRoot, surface.sourceRoot)) {
        throw new TypeError(`surface ${surface.surface.name} sourceRoot overlaps an explicit sharedRoot.`);
      }
    }
  }
  for (let left = 0; left < surfaces.length; left += 1) {
    for (let right = left + 1; right < surfaces.length; right += 1) {
      const first = surfaces[left];
      const second = surfaces[right];
      if (first === undefined || second === undefined) continue;
      if (isInside(first.sourceRoot, second.sourceRoot) || isInside(second.sourceRoot, first.sourceRoot)) {
        throw new TypeError(`surface roots for ${first.surface.name} and ${second.surface.name} overlap.`);
      }
    }
  }
}

function localCandidates(candidate: string): readonly string[] {
  const extension = path.extname(candidate);
  const candidates = [candidate];
  if (extension === "") {
    candidates.push(...SOURCE_EXTENSIONS.map((suffix) => `${candidate}${suffix}`));
    candidates.push(...SOURCE_EXTENSIONS.map((suffix) => path.join(candidate, `index${suffix}`)));
  } else if ([".js", ".mjs", ".cjs"].includes(extension)) {
    const stem = candidate.slice(0, -extension.length);
    candidates.push(...SOURCE_EXTENSIONS.filter((suffix) => suffix !== extension).map((suffix) => `${stem}${suffix}`));
  }
  return candidates;
}

async function resolveLocalSource(root: string, resolveDir: string, specifier: string): Promise<string | undefined> {
  const candidate = path.isAbsolute(specifier) ? path.resolve(specifier) : path.resolve(resolveDir, specifier);
  if (!isInside(root, candidate)) throw new TypeError(`creator source ${JSON.stringify(specifier)} must stay inside the creator root.`);
  for (const option of localCandidates(candidate)) {
    try {
      const resolved = await realpath(option);
      if (!isInside(root, resolved)) throw new TypeError(`creator source ${JSON.stringify(specifier)} escapes the creator root through a symlink.`);
      if (!(await stat(resolved)).isFile()) continue;
      return resolved;
    } catch (error) {
      if (error instanceof TypeError) throw error;
    }
  }
  return undefined;
}

function surfaceForImporter(
  root: string,
  surfaces: readonly PreparedSurface[],
  sharedRoots: readonly string[],
  args: { readonly namespace: string; readonly importer: string },
): PreparedSurface | "shared" | undefined {
  if (args.namespace === "keel-bootstrap" && args.importer.startsWith("keel-entry:")) {
    return surfaces.find((surface) => surface.surface.name === args.importer.slice("keel-entry:".length));
  }
  const importer = path.isAbsolute(args.importer)
    ? path.resolve(args.importer)
    : path.resolve(root, args.importer);
  if (!isInside(root, importer)) return undefined;
  const surface = surfaces.find((candidate) => isInside(candidate.sourceRoot, importer));
  if (surface !== undefined) return surface;
  if (sharedRoots.some((sharedRoot) => isInside(sharedRoot, importer))) return "shared";
  throw new TypeError(`creator source ${JSON.stringify(args.importer)} is outside every declared surface and sharedRoot.`);
}

function sourceBoundaryPlugin(root: string, surfaces: readonly PreparedSurface[], sharedRoots: readonly string[]): Plugin {
  return {
    name: "keel-creator-source-boundary",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^(?:\.{1,2}(?:[/\\]|$)|[/\\])/ }, async (args) => {
        const owner = surfaceForImporter(root, surfaces, sharedRoots, args);
        if (owner === undefined) return undefined;
        const resolved = await resolveLocalSource(root, args.resolveDir, args.path);
        if (resolved === undefined) return undefined;
        const allowedRoots = owner === "shared" ? sharedRoots : [owner.sourceRoot, ...sharedRoots];
        if (!allowedRoots.some((allowedRoot) => isInside(allowedRoot, resolved))) {
          const ownerName = owner === "shared" ? "shared source" : `surface ${owner.surface.name}`;
          return { errors: [{ text: `${ownerName} may not import private source ${args.path}.` }] };
        }
        return { path: resolved };
      });
    },
  };
}

const OUTPUT_MARKER = ".keel-creator-output.json";
const OUTPUT_MARKER_SCHEMA = "keel-creator-output@1";

function ownedOutputPath(outputDirectory: string, file: string): string {
  if (typeof file !== "string" || file === "" || path.isAbsolute(file)) {
    throw new TypeError("creator output marker contains an invalid file path.");
  }
  const resolved = path.resolve(outputDirectory, file);
  if (resolved === outputDirectory || !isInside(outputDirectory, resolved)) {
    throw new TypeError("creator output marker contains a path outside its output directory.");
  }
  return resolved;
}

async function existingDirectoryEntry(directory: string, name: string) {
  try {
    return (await readdir(directory, { withFileTypes: true })).find((entry) => entry.name === name);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Creator output is a file tree, never a link farm. Check every extant path
 * before a bundler writes it or publication reads it. */
async function assertOutputTreeIsSafe(outputDirectory: string): Promise<void> {
  const canonicalOutput = await realpath(outputDirectory);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new TypeError(`creator output contains a symbolic link at ${candidate}.`);
      const resolved = await realpath(candidate);
      if (!isInside(canonicalOutput, resolved)) {
        throw new TypeError(`creator output path ${candidate} escapes its output directory.`);
      }
      if (entry.isDirectory()) await visit(candidate);
    }
  };
  await visit(outputDirectory);
}

/**
 * A marker can name nested outputs, so checking only its lexical paths would
 * follow a directory symlink during rm(). Resolve every existing component
 * before the first deletion and accept only ordinary directories and files
 * rooted in the canonical output directory.
 */
async function assertOwnedOutputPathIsSafe(outputDirectory: string, file: string): Promise<void> {
  const target = ownedOutputPath(outputDirectory, file);
  const canonicalOutput = await realpath(outputDirectory);
  const relative = path.relative(outputDirectory, target);
  let current = outputDirectory;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || part === "") throw new TypeError("creator output marker contains an invalid file path.");
    const details = await existingDirectoryEntry(current, part);
    if (details === undefined) return;
    if (details.isSymbolicLink()) {
      throw new TypeError("creator output marker may not remove through a symbolic link.");
    }
    current = path.join(current, part);
    const resolved = await realpath(current);
    if (!isInside(canonicalOutput, resolved)) {
      throw new TypeError("creator output marker contains a path outside its output directory.");
    }
    const last = index === parts.length - 1;
    if (!last && !details.isDirectory()) {
      throw new TypeError("creator output marker names a non-directory parent path.");
    }
    if (last && !details.isFile()) {
      throw new TypeError("creator output marker may only remove regular files.");
    }
  }
}

async function assertMarkerIsSafe(markerPath: string): Promise<boolean> {
  const details = await existingDirectoryEntry(path.dirname(markerPath), path.basename(markerPath));
  if (details === undefined) return false;
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new TypeError("creator output marker must be an ordinary file; refusing to remove files.");
  }
  return true;
}

/** Remove only exact files a previous successful creator build marked as its own. */
async function clearOwnedOutputs(outputDirectory: string): Promise<void> {
  const markerPath = path.join(outputDirectory, OUTPUT_MARKER);
  if (!await assertMarkerIsSafe(markerPath)) return;
  let raw: string;
  try {
    raw = await readFile(markerPath, "utf8");
  } catch {
    return;
  }
  let marker: unknown;
  try {
    marker = JSON.parse(raw);
  } catch {
    throw new TypeError("creator output marker is not valid JSON; refusing to remove files.");
  }
  if (typeof marker !== "object" || marker === null ||
    (marker as { schema?: unknown }).schema !== OUTPUT_MARKER_SCHEMA ||
    !Array.isArray((marker as { files?: unknown }).files)) {
    throw new TypeError("creator output marker is invalid; refusing to remove files.");
  }
  const files = (marker as { readonly files: readonly unknown[] }).files;
  const paths = files.map((file) => ownedOutputPath(outputDirectory, typeof file === "string" ? file : ""));
  if (new Set(paths).size !== paths.length) throw new TypeError("creator output marker lists a file twice.");
  /* Validate the complete marker before deleting its first output. */
  await Promise.all(files.map((file) => assertOwnedOutputPathIsSafe(outputDirectory, typeof file === "string" ? file : "")));
  for (const file of paths.sort()) await rm(file, { force: true });
  await assertMarkerIsSafe(markerPath);
  await rm(markerPath, { force: true });
}

async function writeOwnedOutputs(outputDirectory: string, files: readonly string[]): Promise<void> {
  const ordered = [...new Set(files)].sort();
  if (ordered.length !== files.length) throw new TypeError("creator build generated the same output twice.");
  for (const file of ordered) ownedOutputPath(outputDirectory, file);
  await writeFile(path.join(outputDirectory, OUTPUT_MARKER), `${JSON.stringify({ schema: OUTPUT_MARKER_SCHEMA, files: ordered }, null, 2)}\n`);
}

async function runGroup(
  root: string,
  outputDirectory: string,
  surfaces: readonly PreparedSurface[],
  sharedRoots: readonly string[],
  subdirectory: string,
): Promise<{ readonly metafile: Metafile; readonly surfaceEntries: ReadonlyMap<string, string> }> {
  await assertOutputTreeIsSafe(outputDirectory);
  const outdir = path.join(outputDirectory, subdirectory);
  const surfaceByName = new Map(surfaces.map((surface) => [surface.surface.name, surface]));
  const entryPoints = Object.fromEntries(surfaces.map((surface) => [surface.surface.name, `keel-entry:${surface.surface.name}`]));
  const bootstrapPlugin: Plugin = {
    name: "keel-creator-bootstrap",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^keel-entry:/ }, (args) => ({ path: args.path, namespace: "keel-bootstrap" }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "keel-bootstrap" }, (args) => {
        const name = args.path.slice("keel-entry:".length);
        const surface = surfaceByName.get(name);
        if (surface === undefined) return { errors: [{ text: `Unknown Keel creator surface ${name}.` }] };
        return {
          loader: "ts",
          resolveDir: root,
          contents: [
            `import declaration from ${JSON.stringify(surface.entry)};`,
            'import { mountModuleDocument } from "@keel/sdk/module";',
            "void mountModuleDocument(declaration);",
          ].join("\n"),
        };
      });
    },
  };
  const result: BuildResult<{ metafile: true }> = await build({
    absWorkingDir: root,
    entryPoints,
    outdir,
    bundle: true,
    splitting: surfaces.length > 1,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    metafile: true,
    sourcemap: false,
    legalComments: "none",
    entryNames: "[name]",
    chunkNames: "shared/[name]-[hash]",
    assetNames: "shared/[name]-[hash]",
    write: true,
    plugins: [bootstrapPlugin, sourceBoundaryPlugin(root, surfaces, sharedRoots)],
  });
  await assertOutputTreeIsSafe(outputDirectory);
  const cssAliases = new Map<string, string>();
  const cssByBytes = new Map<string, string>();
  for (const output of Object.keys(result.metafile.outputs).filter((file) => file.endsWith(".css")).sort()) {
    const integrity = await createIntegrity(new Uint8Array(await readFile(path.resolve(root, output))));
    const canonical = cssByBytes.get(integrity.digest);
    if (canonical === undefined) cssByBytes.set(integrity.digest, output);
    else {
      cssAliases.set(output, canonical);
      await rm(path.resolve(root, output));
    }
  }
  const outputs = Object.fromEntries(Object.entries(result.metafile.outputs)
    .filter(([output]) => !cssAliases.has(output))
    .map(([output, metadata]) => [output, {
      ...metadata,
      ...(metadata.cssBundle === undefined ? {} : { cssBundle: cssAliases.get(metadata.cssBundle) ?? metadata.cssBundle }),
    }]));
  const metafile: Metafile = { ...result.metafile, outputs };

  const surfaceEntries = new Map<string, string>();
  for (const [output, metadata] of Object.entries(metafile.outputs)) {
    if (metadata.entryPoint === undefined) continue;
    const entryName = metadata.entryPoint?.startsWith("keel-bootstrap:keel-entry:") === true
      ? metadata.entryPoint.slice("keel-bootstrap:keel-entry:".length)
      : undefined;
    if (entryName !== undefined && surfaceByName.has(entryName) && output.endsWith(".js")) {
      surfaceEntries.set(entryName, outputRelative(outputDirectory, path.resolve(root, output)));
    }
  }
  return { metafile, surfaceEntries };
}

/**
 * Bundles ordinary TS import graphs and writes complete HTML plus an offline
 * publication plan. Shared-library surfaces use ESM splitting; sandbox
 * surfaces are separate bundles and therefore communicate only through an
 * explicit asynchronous boundary chosen by the application.
 */
export async function buildCreatorProject(options: BuildCreatorProjectOptions): Promise<CreatorPublicationPlan> {
  const root = await realpath(path.resolve(options.root));
  let outputDirectory = path.resolve(options.outputDirectory);
  const outputParent = path.dirname(outputDirectory);
  const outputName = path.basename(outputDirectory);
  let outputDetails = await existingDirectoryEntry(outputParent, outputName);
  if (outputDetails === undefined) {
    await mkdir(outputDirectory, { recursive: true });
    outputDetails = await existingDirectoryEntry(outputParent, outputName);
  }
  if (outputDetails?.isSymbolicLink()) throw new TypeError("creator outputDirectory itself must not be a symbolic link.");
  if (outputDetails === undefined || !outputDetails.isDirectory()) {
    throw new TypeError("creator outputDirectory must be a directory.");
  }
  outputDirectory = await realpath(outputDirectory);
  if (outputDirectory === root) throw new TypeError("creator outputDirectory may not be the creator root.");
  if (options.surfaces.length === 0) throw new TypeError("creator build needs at least one surface.");
  const names = new Set<string>();
  const surfaces: PreparedSurface[] = [];
  for (const surface of options.surfaces) {
    safeName(surface.name);
    if (surface.isolation !== "shared-library" && surface.isolation !== "sandbox") {
      throw new TypeError(`surface ${surface.name} has an unknown isolation policy.`);
    }
    if (names.has(surface.name)) throw new TypeError(`surface ${surface.name} is declared twice.`);
    names.add(surface.name);
    const entry = await resolveEntry(root, surface);
    const sourceRoot = await resolveSurfaceRoot(root, surface, entry);
    surfaces.push({ surface, entry, sourceRoot, document: discoverStaticDocument(entry, surface) });
  }
  const sharedRoots = await resolveSharedRoots(root, options.sharedRoots);
  assertDisjointRoots(surfaces, sharedRoots);
  await assertOutputTreeIsSafe(outputDirectory);
  await clearOwnedOutputs(outputDirectory);
  await assertOutputTreeIsSafe(outputDirectory);

  const builds: { metafile: Metafile; surfaceEntries: ReadonlyMap<string, string> }[] = [];
  const shared = surfaces.filter((surface) => surface.surface.isolation === "shared-library");
  if (shared.length > 0) builds.push(await runGroup(root, outputDirectory, shared, sharedRoots, "library"));
  for (const surface of surfaces.filter((candidate) => candidate.surface.isolation === "sandbox")) {
    builds.push(await runGroup(root, outputDirectory, [surface], sharedRoots, `sandbox/${surface.surface.name}`));
  }

  const outputMetadata = new Map<string, Metafile["outputs"][string]>();
  const outputByRawPath = new Map<string, string>();
  const outputByAbsolutePath = new Map<string, string>();
  const rawOutputByFile = new Map<string, string>();
  const entryBySurface = new Map<string, string>();
  for (const built of builds) {
    for (const [output, metadata] of Object.entries(built.metafile.outputs)) {
      const file = outputRelative(outputDirectory, path.resolve(root, output));
      if (outputMetadata.has(file)) throw new TypeError(`creator build produced duplicate output ${file}.`);
      outputMetadata.set(file, metadata);
      outputByRawPath.set(rawOutputPath(output), file);
      outputByAbsolutePath.set(path.resolve(root, output), file);
      rawOutputByFile.set(file, output);
    }
    for (const [name, entry] of built.surfaceEntries) entryBySurface.set(name, entry);
  }
  await assertOutputTreeIsSafe(outputDirectory);

  const htmlFiles: { name: string; file: string; entry: string; isolation: CreatorSurfaceIsolation }[] = [];
  for (const prepared of [...surfaces].sort((left, right) => left.surface.name.localeCompare(right.surface.name))) {
    const surface = prepared.surface;
    const entry = entryBySurface.get(surface.name);
    if (entry === undefined) throw new Error(`build produced no JavaScript entry for ${surface.name}.`);
    const metadata = outputMetadata.get(entry);
    const htmlFile = `${surface.name}.html`;
    const css = metadata?.cssBundle === undefined ? [] : [outputRelative(outputDirectory, path.resolve(root, metadata.cssBundle))];
    await writeFile(path.join(outputDirectory, htmlFile), html(
      prepared.document,
      emittedOutputSpecifier(htmlFile, entry),
      css.map((file) => emittedOutputSpecifier(htmlFile, file)),
    ));
    htmlFiles.push({ name: surface.name, file: htmlFile, entry, isolation: surface.isolation });
  }

  await assertOutputTreeIsSafe(outputDirectory);
  const files = [...outputMetadata.keys(), ...htmlFiles.map((entry) => entry.file)].sort();
  const nodes = await Promise.all(files.map(async (file) => ({
    key: `object:${file}`,
    file,
    mediaType: mediaType(file),
    integrity: await createIntegrity(new Uint8Array(await readFile(path.join(outputDirectory, file)))),
    objectId: null,
  }) satisfies CreatorObjectNode));
  const edges: CreatorObjectEdge[] = [];
  for (const item of htmlFiles) {
    edges.push({ consumer: `object:${item.file}`, dependency: `object:${item.entry}`, localSpecifier: emittedOutputSpecifier(item.file, item.entry), publishResolution: "object-id-from-receipt" });
    const cssBundle = outputMetadata.get(item.entry)?.cssBundle;
    if (cssBundle !== undefined) {
      const css = outputRelative(outputDirectory, path.resolve(root, cssBundle));
      edges.push({ consumer: `object:${item.file}`, dependency: `object:${css}`, localSpecifier: emittedOutputSpecifier(item.file, css), publishResolution: "object-id-from-receipt" });
    }
  }
  for (const [file, metadata] of outputMetadata) {
    const rawOutput = rawOutputByFile.get(file);
    if (rawOutput === undefined) throw new TypeError(`creator build lost output metadata for ${file}.`);
    for (const imported of metadata.imports) {
      if (imported.external) continue;
      const dependency = canonicalOutputImport(root, outputDirectory, rawOutput, imported.path, outputByRawPath, outputByAbsolutePath);
      edges.push({ consumer: `object:${file}`, dependency: `object:${dependency}`, localSpecifier: emittedOutputSpecifier(file, dependency), publishResolution: "object-id-from-receipt" });
    }
  }
  edges.sort((left, right) => `${left.consumer}\0${left.dependency}`.localeCompare(`${right.consumer}\0${right.dependency}`));
  const plan: CreatorPublicationPlan = Object.freeze({
    schema: "keel-creator-publication-plan@1",
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    surfaces: Object.freeze(htmlFiles.map((item) => Object.freeze({ name: item.name, isolation: item.isolation, html: item.file, entry: item.entry }))),
  });
  await assertOutputTreeIsSafe(outputDirectory);
  await writeFile(path.join(outputDirectory, "keel-publication-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  await writeOwnedOutputs(outputDirectory, [...files, "keel-publication-plan.json"]);
  return plan;
}

/* ── Offline staged publication ────────────────────────────────────────── */

/** Bytes are kept outside the M2 JSON plan so planning never implies an upload. */
export interface CreatorPublicationSource {
  readonly key: string;
  readonly bytes: Uint8Array;
}

export type CreatorReceiptEvidenceStatus = "accepted" | "rejected" | "pending";

/**
 * A publication system returns this after storing one logical object. `accepted`
 * means only that this receipt bound these bytes to an object id; it is not a
 * content-verification verdict.
 */
export interface CreatorPublicationReceipt {
  readonly nodeKey: string;
  readonly originalIntegrity: Integrity;
  readonly preparedIntegrity: Integrity;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly objectId: Hex;
  readonly evidence: Readonly<{ status: CreatorReceiptEvidenceStatus; reference?: string }>;
}

export interface CreatorLogicalObject {
  /** Stable canonical key: the lexicographically first source key in this byte group. */
  readonly key: string;
  /** Every source node represented by this deduplicated object remains explicit. */
  readonly aliases: readonly string[];
  readonly mediaType: string;
  readonly originalIntegrity: Integrity;
  readonly originalBytes: Uint8Array;
}

export interface CreatorLogicalEdge {
  readonly consumer: string;
  readonly dependency: string;
  readonly localSpecifier: string;
  /** Source graph edges folded into this one logical rewrite, retained for audit. */
  readonly sourceEdges: readonly Readonly<{ consumer: string; dependency: string }>[];
}

export interface CreatorPublicationStage {
  readonly index: number;
  readonly nodeKeys: readonly string[];
}

export interface CreatorPreparedPublication {
  readonly schema: "keel-creator-staged-publication@1";
  /**
   * Runtime publication data. Byte fields remain Uint8Array instances for
   * integrity checks; use serializeCreatorPreparedPublication for JSON.
   */
  readonly nodes: readonly CreatorLogicalObject[];
  readonly edges: readonly CreatorLogicalEdge[];
  /** Leaves first; every dependency is in an earlier stage. */
  readonly stages: readonly CreatorPublicationStage[];
  readonly roots: readonly string[];
}

/** Exact unsigned bytes that are ready for the next storage stage. */
export interface CreatorPublicationReadyObject extends CreatorLogicalObject {
  readonly preparedIntegrity: Integrity;
  readonly preparedBytes: Uint8Array;
}

export interface CreatorPublicationAdvance {
  readonly schema: "keel-creator-publication-advance@1";
  /** Accepted completed stages, in deterministic stage order. */
  readonly acceptedNodeKeys: readonly string[];
  /** Null only after every stage has a valid accepted receipt. */
  readonly readyStage: CreatorPublicationStage | null;
  /** The complete next stage to store; no transport action is performed. */
  readonly ready: readonly CreatorPublicationReadyObject[];
}

export interface CreatorResolvedObject extends CreatorLogicalObject {
  readonly preparedIntegrity: Integrity;
  readonly preparedBytes: Uint8Array;
  readonly objectId: Hex;
  /** A committed creator-facing resource alias, never a transport locator. */
  readonly resourceId: string;
  readonly alias: string;
  readonly receipt: CreatorPublicationReceipt;
}

export interface CreatorResolvedPublication {
  readonly schema: "keel-creator-resolved-publication@1";
  /**
   * Runtime publication data. Byte fields remain Uint8Array instances for
   * integrity checks; use serializeCreatorResolvedPublication for JSON.
   */
  readonly nodes: readonly CreatorResolvedObject[];
  readonly edges: readonly (CreatorLogicalEdge & Readonly<{ resolvedAlias: string }>)[];
  readonly stages: readonly CreatorPublicationStage[];
  readonly roots: readonly CreatorResolvedObject[];
}

/** A deterministic JSON envelope for runtime-only publication bytes. */
export interface CreatorPublicationBytesJson {
  readonly encoding: "hex";
  readonly data: string;
}

export type CreatorLogicalObjectJson = Omit<CreatorLogicalObject, "originalBytes"> & Readonly<{
  originalBytes: CreatorPublicationBytesJson;
}>;

export type CreatorPublicationReadyObjectJson = Omit<CreatorPublicationReadyObject, "originalBytes" | "preparedBytes"> & Readonly<{
  originalBytes: CreatorPublicationBytesJson;
  preparedBytes: CreatorPublicationBytesJson;
}>;

export type CreatorResolvedObjectJson = Omit<CreatorResolvedObject, "originalBytes" | "preparedBytes"> & Readonly<{
  originalBytes: CreatorPublicationBytesJson;
  preparedBytes: CreatorPublicationBytesJson;
}>;

/** JSON-safe, deterministic view of a prepared runtime publication. */
export interface CreatorPreparedPublicationJson {
  readonly schema: CreatorPreparedPublication["schema"];
  readonly nodes: readonly CreatorLogicalObjectJson[];
  readonly edges: readonly CreatorLogicalEdge[];
  readonly stages: readonly CreatorPublicationStage[];
  readonly roots: readonly string[];
}

/** JSON-safe, deterministic view of an advance response. */
export interface CreatorPublicationAdvanceJson {
  readonly schema: CreatorPublicationAdvance["schema"];
  readonly acceptedNodeKeys: readonly string[];
  readonly readyStage: CreatorPublicationStage | null;
  readonly ready: readonly CreatorPublicationReadyObjectJson[];
}

/** JSON-safe, deterministic view of a resolved runtime publication. */
export interface CreatorResolvedPublicationJson {
  readonly schema: CreatorResolvedPublication["schema"];
  readonly nodes: readonly CreatorResolvedObjectJson[];
  readonly edges: readonly (CreatorLogicalEdge & Readonly<{ resolvedAlias: string }> )[];
  readonly stages: readonly CreatorPublicationStage[];
  readonly roots: readonly CreatorResolvedObjectJson[];
}

const OBJECT_ID = /^0x[0-9a-f]{64}$/u;
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+(?:;.*)?$/u;
const MAX_PUBLICATION_TEXT = 1024;
const utf8 = new TextEncoder();
const decodeUtf8 = new TextDecoder("utf-8", { fatal: true });
const CONTROL_TEXT = /[\u0000-\u001f\u007f]/u;

function integrityEqual(left: Integrity, right: Integrity): boolean {
  return left.algorithm === right.algorithm && left.digest === right.digest && left.byteLength === right.byteLength;
}

function cloneIntegrity(value: Integrity): Integrity {
  return Object.freeze({ algorithm: value.algorithm, digest: value.digest, ...(value.byteLength === undefined ? {} : { byteLength: value.byteLength }) });
}

function jsonBytes(value: Uint8Array): CreatorPublicationBytesJson {
  return Object.freeze({ encoding: "hex", data: Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("") });
}

function jsonLogicalObject(value: CreatorLogicalObject): CreatorLogicalObjectJson {
  return Object.freeze({
    key: value.key,
    aliases: Object.freeze([...value.aliases]),
    mediaType: value.mediaType,
    originalIntegrity: cloneIntegrity(value.originalIntegrity),
    originalBytes: jsonBytes(value.originalBytes),
  });
}

function jsonReadyObject(value: CreatorPublicationReadyObject): CreatorPublicationReadyObjectJson {
  return Object.freeze({
    ...jsonLogicalObject(value),
    preparedIntegrity: cloneIntegrity(value.preparedIntegrity),
    preparedBytes: jsonBytes(value.preparedBytes),
  });
}

function jsonResolvedObject(value: CreatorResolvedObject): CreatorResolvedObjectJson {
  return Object.freeze({
    ...jsonReadyObject(value),
    objectId: value.objectId,
    resourceId: value.resourceId,
    alias: value.alias,
    receipt: snapshotReceipt(value.receipt),
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function requireObjectId(value: string, label: string): asserts value is Hex {
  if (!OBJECT_ID.test(value)) throw new TypeError(`${label} must be a canonical lowercase 32-byte object id.`);
}

function sourceKey(value: string): string {
  return boundedText(value, "creator publication node key");
}

function plainPrototype(value: object, prototype: object, label: string): void {
  try {
    if (utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== prototype) throw new TypeError(label);
  } catch {
    throw new TypeError(`${label} must be ordinary plain data.`);
  }
}

function exactDataObject(value: unknown, label: string, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) throw new TypeError(`${label} must be an object with an exact data shape.`);
  plainPrototype(value, Object.prototype, label);
  let actualKeys: readonly PropertyKey[];
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    actualKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  } catch {
    throw new TypeError(`${label} must have an exact data shape.`);
  }
  if (actualKeys.length !== keys.length || actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`${label} must have an exact data shape.`);
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must have an exact data shape.`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function exactDataArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an ordinary array.`);
  plainPrototype(value, Array.prototype, label);
  let keys: readonly PropertyKey[];
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  } catch { throw new TypeError(`${label} must be an ordinary data array.`); }
  if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)))) {
    throw new TypeError(`${label} must be an ordinary data array.`);
  }
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") {
    throw new TypeError(`${label} must be an ordinary data array.`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must be an ordinary data array.`);
    }
    snapshot.push(descriptor.value);
  }
  if (keys.length !== snapshot.length + 1) throw new TypeError(`${label} must be an ordinary data array.`);
  return Object.freeze(snapshot);
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_PUBLICATION_TEXT || CONTROL_TEXT.test(value)) {
    throw new TypeError(`${label} must be a nonempty bounded string.`);
  }
  return value;
}

function publicationOutputPath(value: unknown, label: string, extension: string): string {
  const text = boundedText(value, label);
  if (!text.endsWith(extension) || path.isAbsolute(text) || text.split("/").some((part) => part === "" || part === "." || part === "..") || text.includes("\\")) {
    throw new TypeError(`${label} must be a safe relative ${extension} output path.`);
  }
  return text;
}

function validatePlanIntegrity(value: unknown, label: string): Integrity {
  const fields = exactDataObject(value, label, ["algorithm", "digest", "byteLength"]);
  const algorithm = boundedText(fields.algorithm, `${label} algorithm`);
  const digest = boundedText(fields.digest, `${label} digest`);
  if ((algorithm !== "sha256" && algorithm !== "keccak256" && algorithm !== "none") || !/^0x[0-9a-f]*$/u.test(digest)
    || typeof fields.byteLength !== "number" || !Number.isSafeInteger(fields.byteLength) || fields.byteLength < 0) {
    throw new TypeError(`${label} is invalid.`);
  }
  return Object.freeze({ algorithm, digest: digest as Hex, byteLength: fields.byteLength });
}

function validatePlanNode(value: unknown): CreatorObjectNode {
  const fields = exactDataObject(value, "creator publication node", ["key", "file", "mediaType", "integrity", "objectId"]);
  const key = sourceKey(fields.key as string);
  const file = boundedText(fields.file, "creator publication node file");
  const mediaType = boundedText(fields.mediaType, "creator publication node mediaType");
  if (path.isAbsolute(file) || !isInside(path.resolve("."), path.resolve(".", file)) || fields.objectId !== null) {
    throw new TypeError("creator publication node has an invalid exact shape.");
  }
  const integrity = validatePlanIntegrity(fields.integrity, `node ${key} integrity`);
  return Object.freeze({ key, file, mediaType, integrity, objectId: null });
}

function validatePlanEdge(value: unknown): CreatorObjectEdge {
  const fields = exactDataObject(value, "creator publication edge", ["consumer", "dependency", "localSpecifier", "publishResolution"]);
  const consumer = boundedText(fields.consumer, "creator publication edge consumer");
  const dependency = boundedText(fields.dependency, "creator publication edge dependency");
  const localSpecifier = boundedText(fields.localSpecifier, "creator publication edge localSpecifier");
  if (fields.publishResolution !== "object-id-from-receipt") {
    throw new TypeError("creator publication edge has an invalid exact shape.");
  }
  return Object.freeze({ consumer, dependency, localSpecifier, publishResolution: "object-id-from-receipt" });
}

function validatePlanSurface(value: unknown): CreatorPublicationPlan["surfaces"][number] {
  const fields = exactDataObject(value, "creator publication surface", ["name", "isolation", "html", "entry"]);
  const name = boundedText(fields.name, "creator publication surface name");
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(name) || fields.isolation !== "shared-library" && fields.isolation !== "sandbox") {
    throw new TypeError("creator publication surface has an invalid exact shape.");
  }
  const html = publicationOutputPath(fields.html, "creator publication surface html", ".html");
  const entry = publicationOutputPath(fields.entry, "creator publication surface entry", ".js");
  return Object.freeze({ name, isolation: fields.isolation, html, entry });
}

function validatePublicationPlan(plan: CreatorPublicationPlan): CreatorPublicationPlan {
  const fields = exactDataObject(plan, "creator publication plan", ["schema", "nodes", "edges", "surfaces"]);
  if (fields.schema !== "keel-creator-publication-plan@1") {
    throw new TypeError("unsupported creator publication plan schema.");
  }
  const nodes = Object.freeze(exactDataArray(fields.nodes, "creator publication plan nodes").map(validatePlanNode));
  const edges = Object.freeze(exactDataArray(fields.edges, "creator publication plan edges").map(validatePlanEdge));
  const surfaces = Object.freeze(exactDataArray(fields.surfaces, "creator publication plan surfaces").map(validatePlanSurface));
  return Object.freeze({ schema: "keel-creator-publication-plan@1", nodes, edges, surfaces });
}

function dependencyStages(nodes: readonly string[], edges: readonly CreatorLogicalEdge[]): readonly CreatorPublicationStage[] {
  const dependencies = new Map(nodes.map((key) => [key, new Set<string>()]));
  for (const edge of edges) dependencies.get(edge.consumer)?.add(edge.dependency);
  const remaining = new Set(nodes);
  const stages: CreatorPublicationStage[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((key) => [...(dependencies.get(key) ?? [])].every((dependency) => !remaining.has(dependency))).sort();
    if (ready.length === 0) throw new TypeError("creator publication graph is cyclic.");
    stages.push(Object.freeze({ index: stages.length, nodeKeys: Object.freeze(ready) }));
    for (const key of ready) remaining.delete(key);
  }
  return Object.freeze(stages);
}

/**
 * Converts M2 output bytes into a deterministic logical graph. Equal bytes
 * deduplicate only inside the same media type; aliases and original consumers
 * are retained so later substitution remains auditable.
 */
export async function prepareCreatorPublication(
  plan: CreatorPublicationPlan,
  sources: readonly CreatorPublicationSource[],
): Promise<CreatorPreparedPublication> {
  const normalizedPlan = validatePublicationPlan(plan);
  const sourceEntries = exactDataArray(sources, "creator publication sources");
  const sourceByKey = new Map<string, Uint8Array>();
  for (const source of sourceEntries) {
    const fields = exactDataObject(source, "creator publication source", ["key", "bytes"]);
    const key = sourceKey(fields.key as string);
    if (!(fields.bytes instanceof Uint8Array) || utilTypes.isProxy(fields.bytes)) {
      throw new TypeError(`source bytes for ${key} must be a Uint8Array.`);
    }
    if (sourceByKey.has(key)) throw new TypeError(`duplicate source bytes for ${key}.`);
    sourceByKey.set(key, new Uint8Array(fields.bytes));
  }
  const planKeys = new Set<string>();
  const materialized: Array<CreatorObjectNode & Readonly<{ bytes: Uint8Array }>> = [];
  for (const node of normalizedPlan.nodes) {
    sourceKey(node.key);
    if (planKeys.has(node.key)) throw new TypeError(`duplicate plan node ${node.key}.`);
    planKeys.add(node.key);
    if (!MEDIA_TYPE.test(node.mediaType)) throw new TypeError(`node ${node.key} has an invalid media type.`);
    const bytes = sourceByKey.get(node.key);
    if (bytes === undefined) throw new TypeError(`missing source bytes for ${node.key}.`);
    const actual = await createIntegrity(bytes, node.integrity.algorithm);
    if (!integrityEqual(actual, node.integrity)) throw new TypeError(`source bytes for ${node.key} do not match the plan integrity.`);
    materialized.push({ ...node, bytes });
  }
  for (const key of sourceByKey.keys()) if (!planKeys.has(key)) throw new TypeError(`source bytes include unknown node ${key}.`);

  const canonicalBySource = new Map<string, string>();
  const groups: CreatorLogicalObject[] = [];
  for (const candidate of [...materialized].sort((left, right) => left.key.localeCompare(right.key))) {
    const match = groups.find((node) => node.mediaType === candidate.mediaType && bytesEqual(node.originalBytes, candidate.bytes));
    if (match !== undefined) {
      canonicalBySource.set(candidate.key, match.key);
      const aliases = Object.freeze([...match.aliases, candidate.key].sort());
      groups[groups.indexOf(match)] = Object.freeze({ ...match, aliases });
      continue;
    }
    const node = Object.freeze({
      key: candidate.key,
      aliases: Object.freeze([candidate.key]),
      mediaType: candidate.mediaType,
      originalIntegrity: cloneIntegrity(candidate.integrity),
      originalBytes: new Uint8Array(candidate.bytes),
    });
    groups.push(node);
    canonicalBySource.set(candidate.key, node.key);
  }
  const logicalByKey = new Map(groups.map((node) => [node.key, node]));
  const edgeByConsumerSpecifier = new Map<string, CreatorLogicalEdge>();
  const originalConsumerSpecifier = new Set<string>();
  for (const edge of normalizedPlan.edges) {
    if (!planKeys.has(edge.consumer) || !planKeys.has(edge.dependency)) throw new TypeError("creator publication edge references an unknown node.");
    if (typeof edge.localSpecifier !== "string" || edge.localSpecifier === "") throw new TypeError("creator publication edges need a nonempty local specifier.");
    const originalKey = `${edge.consumer}\0${edge.localSpecifier}`;
    if (originalConsumerSpecifier.has(originalKey)) throw new TypeError(`duplicate or ambiguous edge ${edge.consumer} -> ${edge.localSpecifier}.`);
    originalConsumerSpecifier.add(originalKey);
    const consumer = canonicalBySource.get(edge.consumer)!;
    const dependency = canonicalBySource.get(edge.dependency)!;
    if (consumer === dependency) throw new TypeError(`creator publication edge ${edge.consumer} becomes a logical self-cycle.`);
    const key = `${consumer}\0${edge.localSpecifier}`;
    const existing = edgeByConsumerSpecifier.get(key);
    if (existing !== undefined && existing.dependency !== dependency) {
      throw new TypeError(`deduplicated consumer ${consumer} has conflicting dependency edges for ${edge.localSpecifier}.`);
    }
    const sourceEdges = Object.freeze([...(existing?.sourceEdges ?? []), Object.freeze({ consumer: edge.consumer, dependency: edge.dependency })]
      .sort((left, right) => `${left.consumer}\0${left.dependency}`.localeCompare(`${right.consumer}\0${right.dependency}`)));
    edgeByConsumerSpecifier.set(key, Object.freeze({ consumer, dependency, localSpecifier: edge.localSpecifier, sourceEdges }));
  }
  const edges = Object.freeze([...edgeByConsumerSpecifier.values()].sort((left, right) =>
    `${left.consumer}\0${left.dependency}\0${left.localSpecifier}`.localeCompare(`${right.consumer}\0${right.dependency}\0${right.localSpecifier}`)));
  const nodes = Object.freeze([...logicalByKey.values()].sort((left, right) => left.key.localeCompare(right.key)));
  const stages = dependencyStages(nodes.map((node) => node.key), edges);
  const consumers = new Set(edges.map((edge) => edge.dependency));
  const roots = Object.freeze(nodes.map((node) => node.key).filter((key) => !consumers.has(key)).sort());
  return Object.freeze({ schema: "keel-creator-staged-publication@1", nodes, edges, stages, roots });
}

/** Convenience for a locally-built creator directory; it only reads bytes. */
export async function prepareCreatorPublicationFromDirectory(
  plan: CreatorPublicationPlan,
  outputDirectory: string,
): Promise<CreatorPreparedPublication> {
  validatePublicationPlan(plan);
  let root = path.resolve(outputDirectory);
  const details = await existingDirectoryEntry(path.dirname(root), path.basename(root));
  if (details === undefined || !details.isDirectory() || details.isSymbolicLink()) {
    throw new TypeError("creator publication outputDirectory must be an ordinary directory.");
  }
  root = await realpath(root);
  await assertOutputTreeIsSafe(root);
  const sources = await Promise.all(plan.nodes.map(async (node) => {
    const file = ownedOutputPath(root, node.file);
    await assertOwnedOutputPathIsSafe(root, node.file);
    return { key: node.key, bytes: new Uint8Array(await readFile(file)) };
  }));
  return prepareCreatorPublication(plan, sources);
}

type Rewrite = Readonly<{ start: number; end: number; replacement: string }>;

interface QuotedToken {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function htmlQuotedAttributes(text: string, start: number, end: number): readonly Readonly<{ name: string; token: QuotedToken }>[] {
  const attributes: Array<Readonly<{ name: string; token: QuotedToken }>> = [];
  let index = start;
  while (index < end) {
    while (index < end && /\s/u.test(text[index]!)) index += 1;
    if (index >= end || text[index] === "/") break;
    const nameStart = index;
    while (index < end && /[A-Za-z0-9_:.-]/u.test(text[index]!)) index += 1;
    if (nameStart === index) { index += 1; continue; }
    const name = text.slice(nameStart, index).toLowerCase();
    while (index < end && /\s/u.test(text[index]!)) index += 1;
    if (text[index] !== "=") continue;
    index += 1;
    while (index < end && /\s/u.test(text[index]!)) index += 1;
    const quote = text[index];
    if (quote !== "\"" && quote !== "'") {
      while (index < end && !/\s/u.test(text[index]!)) index += 1;
      continue;
    }
    const tokenStart = index;
    index += 1;
    const valueStart = index;
    while (index < end && text[index] !== quote) index += 1;
    if (index >= end) break;
    attributes.push(Object.freeze({ name, token: Object.freeze({ value: text.slice(valueStart, index), start: tokenStart, end: index + 1 }) }));
    index += 1;
  }
  return attributes;
}

function htmlSpecifierRanges(text: string, specifier: string, replacement: string): readonly Rewrite[] {
  const ranges: Rewrite[] = [];
  let index = 0;
  const lower = text.toLowerCase();
  while (index < text.length) {
    const start = text.indexOf("<", index);
    if (start < 0) break;
    if (text.startsWith("<!--", start)) {
      const close = text.indexOf("-->", start + 4);
      index = close < 0 ? text.length : close + 3;
      continue;
    }
    let cursor = start + 1;
    while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor += 1;
    const nameStart = cursor;
    while (cursor < text.length && /[A-Za-z0-9]/u.test(text[cursor]!)) cursor += 1;
    const name = text.slice(nameStart, cursor).toLowerCase();
    let quote: string | undefined;
    while (cursor < text.length) {
      const character = text[cursor]!;
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === "\"" || character === "'") quote = character;
      else if (character === ">") break;
      cursor += 1;
    }
    if (cursor >= text.length) break;
    if (name === "script" || name === "link") {
      const attributes = htmlQuotedAttributes(text, nameStart + name.length, cursor);
      const isStylesheet = name === "link" && attributes.some((attribute) => attribute.name === "rel"
        && attribute.token.value.toLowerCase().split(/\s+/u).includes("stylesheet"));
      const expectedAttribute = name === "script" ? "src" : isStylesheet ? "href" : undefined;
      if (expectedAttribute !== undefined) {
        for (const attribute of attributes) {
          if (attribute.name === expectedAttribute && attribute.token.value === specifier) {
            ranges.push({ start: attribute.token.start, end: attribute.token.end, replacement });
          }
        }
      }
    }
    index = cursor + 1;
    if (name === "script" || name === "style") {
      const close = lower.indexOf(`</${name}`, index);
      if (close >= 0) index = close + 2;
    }
  }
  return ranges;
}

function cssIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_-]/u.test(value);
}

function cssQuotedToken(text: string, start: number): QuotedToken | undefined {
  const quote = text[start];
  if (quote !== "\"" && quote !== "'") return undefined;
  let index = start + 1;
  const valueStart = index;
  while (index < text.length) {
    if (text[index] === "\\") { index += 2; continue; }
    if (text[index] === quote) return Object.freeze({ value: text.slice(valueStart, index), start, end: index + 1 });
    index += 1;
  }
  return undefined;
}

function cssUrlToken(text: string, start: number): QuotedToken | undefined {
  if (text.slice(start, start + 3).toLowerCase() !== "url" || cssIdentifierCharacter(text[start - 1]) || cssIdentifierCharacter(text[start + 3])) return undefined;
  let index = start + 3;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  if (text[index] !== "(") return undefined;
  index += 1;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  const token = cssQuotedToken(text, index);
  if (token === undefined) return undefined;
  index = token.end;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  return text[index] === ")" ? token : undefined;
}

function cssSpecifierRanges(text: string, specifier: string, replacement: string): readonly Rewrite[] {
  const ranges: Rewrite[] = [];
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("/*", index)) {
      const close = text.indexOf("*/", index + 2);
      index = close < 0 ? text.length : close + 2;
      continue;
    }
    if (text[index] === "\"" || text[index] === "'") {
      const token = cssQuotedToken(text, index);
      index = token === undefined ? text.length : token.end;
      continue;
    }
    if (text[index] === "@" && text.slice(index + 1, index + 7).toLowerCase() === "import" && !cssIdentifierCharacter(text[index + 7])) {
      let cursor = index + 7;
      while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
      const token = cssQuotedToken(text, cursor) ?? cssUrlToken(text, cursor);
      if (token !== undefined) {
        if (token.value === specifier) ranges.push({ start: token.start, end: token.end, replacement });
        index = token.end;
        continue;
      }
    }
    const url = cssUrlToken(text, index);
    if (url !== undefined) {
      if (url.value === specifier) ranges.push({ start: url.start, end: url.end, replacement });
      index = url.end;
      continue;
    }
    index += 1;
  }
  return ranges;
}

function specifierRanges(media: string, text: string, specifier: string, replacement: string): readonly Rewrite[] {
  const ranges: Rewrite[] = [];
  const add = (start: number, end: number): void => { ranges.push({ start, end, replacement }); };
  if (media === "text/javascript" || media === "application/javascript") {
    const file = ts.createSourceFile("creator-output.js", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node): void => {
      const literal = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
          : undefined;
      if (literal !== undefined && ts.isStringLiteral(literal) && literal.text === specifier) add(literal.getStart(file), literal.getEnd());
      ts.forEachChild(node, visit);
    };
    visit(file);
    return ranges;
  }
  if (media === "text/html") return htmlSpecifierRanges(text, specifier, replacement);
  if (media === "text/css") return cssSpecifierRanges(text, specifier, replacement);
  throw new TypeError(`cannot substitute dependency edges into ${media}.`);
}

async function verifiedOriginalBytes(node: CreatorLogicalObject): Promise<Uint8Array> {
  const bytes = new Uint8Array(node.originalBytes);
  const actual = await createIntegrity(bytes, node.originalIntegrity.algorithm);
  if (!integrityEqual(actual, node.originalIntegrity)) {
    throw new TypeError(`creator publication node ${node.key} original bytes no longer match their integrity.`);
  }
  return bytes;
}

async function substituteEdges(node: CreatorLogicalObject, edges: readonly CreatorLogicalEdge[], aliases: ReadonlyMap<string, string>): Promise<Uint8Array> {
  const originalBytes = await verifiedOriginalBytes(node);
  if (edges.length === 0) return originalBytes;
  let text: string;
  try { text = decodeUtf8.decode(originalBytes); } catch { throw new TypeError(`consumer ${node.key} is not valid UTF-8.`); }
  if (!bytesEqual(utf8.encode(text), originalBytes)) throw new TypeError(`consumer ${node.key} is not canonical UTF-8.`);
  const rewrites: Rewrite[] = [];
  for (const edge of edges) {
    const alias = aliases.get(edge.dependency);
    if (alias === undefined) throw new TypeError(`dependency ${edge.dependency} has no accepted receipt yet.`);
    const ranges = specifierRanges(node.mediaType, text, edge.localSpecifier, JSON.stringify(alias));
    if (ranges.length !== 1) throw new TypeError(`edge ${edge.consumer} -> ${edge.localSpecifier} is ambiguous or absent in its consumer bytes.`);
    rewrites.push(ranges[0]!);
  }
  rewrites.sort((left, right) => right.start - left.start);
  for (let index = 1; index < rewrites.length; index += 1) {
    if (rewrites[index - 1]!.start < rewrites[index]!.end) throw new TypeError(`consumer ${node.key} has overlapping dependency substitutions.`);
  }
  for (const rewrite of rewrites) text = `${text.slice(0, rewrite.start)}${rewrite.replacement}${text.slice(rewrite.end)}`;
  return utf8.encode(text);
}

function snapshotLogicalObject(node: CreatorLogicalObject, originalBytes: Uint8Array): CreatorLogicalObject {
  return Object.freeze({
    key: node.key,
    aliases: Object.freeze([...node.aliases]),
    mediaType: node.mediaType,
    originalIntegrity: cloneIntegrity(node.originalIntegrity),
    originalBytes: new Uint8Array(originalBytes),
  });
}

function snapshotReceipt(receipt: CreatorPublicationReceipt): CreatorPublicationReceipt {
  return Object.freeze({
    nodeKey: receipt.nodeKey,
    originalIntegrity: cloneIntegrity(receipt.originalIntegrity),
    preparedIntegrity: cloneIntegrity(receipt.preparedIntegrity),
    byteLength: receipt.byteLength,
    mediaType: receipt.mediaType,
    objectId: receipt.objectId,
    evidence: Object.freeze({ status: receipt.evidence.status, ...(receipt.evidence.reference === undefined ? {} : { reference: receipt.evidence.reference }) }),
  });
}

function validateReceiptEvidence(value: unknown): CreatorPublicationReceipt["evidence"] {
  if (typeof value !== "object" || value === null) throw new TypeError("creator publication receipt evidence has an invalid exact shape.");
  plainPrototype(value, Object.prototype, "creator publication receipt evidence");
  let ownKeys: readonly PropertyKey[];
  try { ownKeys = Reflect.ownKeys(value); } catch { throw new TypeError("creator publication receipt evidence has an invalid exact shape."); }
  const keys = ownKeys.includes("reference") ? ["status", "reference"] : ["status"];
  const fields = exactDataObject(value, "creator publication receipt evidence", keys);
  if (fields.status !== "accepted" && fields.status !== "rejected" && fields.status !== "pending") {
    throw new TypeError("creator publication receipt evidence status is invalid.");
  }
  const reference = fields.reference === undefined ? undefined : boundedText(fields.reference, "creator publication receipt evidence reference");
  return Object.freeze({ status: fields.status, ...(reference === undefined ? {} : { reference }) });
}

function validateReceipt(value: unknown): CreatorPublicationReceipt {
  const fields = exactDataObject(value, "creator publication receipt", ["nodeKey", "originalIntegrity", "preparedIntegrity", "byteLength", "mediaType", "objectId", "evidence"]);
  const nodeKey = sourceKey(fields.nodeKey as string);
  const originalIntegrity = validatePlanIntegrity(fields.originalIntegrity, "creator publication receipt originalIntegrity");
  const preparedIntegrity = validatePlanIntegrity(fields.preparedIntegrity, "creator publication receipt preparedIntegrity");
  const mediaType = boundedText(fields.mediaType, "creator publication receipt mediaType");
  if (typeof fields.byteLength !== "number" || !Number.isSafeInteger(fields.byteLength) || fields.byteLength < 0
    || !MEDIA_TYPE.test(mediaType)
    || typeof fields.objectId !== "string") {
    throw new TypeError("creator publication receipt has an invalid exact shape.");
  }
  requireObjectId(fields.objectId, "creator publication receipt objectId");
  const evidence = validateReceiptEvidence(fields.evidence);
  return Object.freeze({ nodeKey, originalIntegrity, preparedIntegrity, byteLength: fields.byteLength, mediaType, objectId: fields.objectId, evidence });
}

function receiptMapFor(
  prepared: CreatorPreparedPublication,
  receipts: readonly CreatorPublicationReceipt[],
): ReadonlyMap<string, CreatorPublicationReceipt> {
  const nodes = new Set(prepared.nodes.map((node) => node.key));
  const receiptByKey = new Map<string, CreatorPublicationReceipt>();
  for (const candidate of exactDataArray(receipts, "creator publication receipts")) {
    const receipt = validateReceipt(candidate);
    if (!nodes.has(receipt.nodeKey)) throw new TypeError(`receipt names unknown node ${receipt.nodeKey}.`);
    if (receiptByKey.has(receipt.nodeKey)) throw new TypeError(`duplicate receipt for ${receipt.nodeKey}.`);
    receiptByKey.set(receipt.nodeKey, receipt);
  }
  return receiptByKey;
}

interface CreatorPublicationProgress {
  readonly resolved: readonly CreatorResolvedObject[];
  readonly acceptedNodeKeys: readonly string[];
  readonly readyStage: CreatorPublicationStage | null;
  readonly ready: readonly CreatorPublicationReadyObject[];
}

async function progressCreatorPublication(
  prepared: CreatorPreparedPublication,
  receipts: readonly CreatorPublicationReceipt[],
): Promise<CreatorPublicationProgress> {
  if (prepared.schema !== "keel-creator-staged-publication@1") throw new TypeError("unsupported staged creator publication schema.");
  const nodes = new Map(prepared.nodes.map((node) => [node.key, node]));
  const receiptByKey = receiptMapFor(prepared, receipts);
  const byConsumer = new Map<string, CreatorLogicalEdge[]>();
  for (const edge of prepared.edges) byConsumer.set(edge.consumer, [...(byConsumer.get(edge.consumer) ?? []), edge]);
  const aliases = new Map<string, string>();
  const objectIds = new Map<string, string>();
  const resolved: CreatorResolvedObject[] = [];
  const acceptedNodeKeys: string[] = [];
  for (const stage of prepared.stages) {
    const stageReceipts = stage.nodeKeys.map((key) => receiptByKey.get(key)).filter((receipt): receipt is CreatorPublicationReceipt => receipt !== undefined);
    if (stageReceipts.length === 0) {
      if (acceptedNodeKeys.length !== receiptByKey.size) {
        throw new TypeError(`receipt for a later creator publication stage was supplied before its dependencies were accepted.`);
      }
      const ready = await Promise.all(stage.nodeKeys.map(async (key) => {
        const node = nodes.get(key);
        if (node === undefined) throw new TypeError(`missing staged node ${key}.`);
        const preparedBytes = await substituteEdges(node, byConsumer.get(key) ?? [], aliases);
        const originalBytes = await verifiedOriginalBytes(node);
        return Object.freeze({
          ...snapshotLogicalObject(node, originalBytes),
          preparedIntegrity: cloneIntegrity(await createIntegrity(preparedBytes, node.originalIntegrity.algorithm)),
          preparedBytes: new Uint8Array(preparedBytes),
        }) satisfies CreatorPublicationReadyObject;
      }));
      return Object.freeze({
        resolved: Object.freeze(resolved),
        acceptedNodeKeys: Object.freeze(acceptedNodeKeys),
        readyStage: stage,
        ready: Object.freeze(ready),
      });
    }
    if (stageReceipts.length !== stage.nodeKeys.length) {
      throw new TypeError(`creator publication receipts must complete stage ${stage.index} before another stage can begin.`);
    }
    for (const key of stage.nodeKeys) {
      const node = nodes.get(key);
      const receipt = receiptByKey.get(key);
      if (node === undefined || receipt === undefined) throw new TypeError(`missing staged node or receipt for ${key}.`);
      const preparedBytes = await substituteEdges(node, byConsumer.get(key) ?? [], aliases);
      const preparedIntegrity = await createIntegrity(preparedBytes, node.originalIntegrity.algorithm);
      if (receipt.evidence.status !== "accepted") throw new TypeError(`receipt for ${key} is not accepted evidence.`);
      requireObjectId(receipt.objectId, `receipt for ${key}`);
      if (objectIds.has(receipt.objectId)) {
        throw new TypeError(`receipt for ${key} reuses object id ${receipt.objectId} already bound to ${objectIds.get(receipt.objectId)}.`);
      }
      if (receipt.mediaType !== node.mediaType || receipt.byteLength !== preparedBytes.byteLength
        || !integrityEqual(receipt.originalIntegrity, node.originalIntegrity)
        || !integrityEqual(receipt.preparedIntegrity, preparedIntegrity)) {
        throw new TypeError(`receipt for ${key} does not bind the current staged bytes.`);
      }
      objectIds.set(receipt.objectId, key);
      const resourceId = `creator/${receipt.objectId.slice(2)}`;
      const alias = `keel://${resourceId}`;
      aliases.set(key, alias);
      const originalBytes = await verifiedOriginalBytes(node);
      resolved.push(Object.freeze({
        ...snapshotLogicalObject(node, originalBytes),
        preparedIntegrity: cloneIntegrity(preparedIntegrity),
        preparedBytes: new Uint8Array(preparedBytes),
        objectId: receipt.objectId,
        resourceId,
        alias,
        receipt: snapshotReceipt(receipt),
      }));
      acceptedNodeKeys.push(key);
    }
  }
  if (acceptedNodeKeys.length !== receiptByKey.size) throw new TypeError("receipt names an unavailable creator publication stage.");
  return Object.freeze({
    resolved: Object.freeze(resolved),
    acceptedNodeKeys: Object.freeze(acceptedNodeKeys),
    readyStage: null,
    ready: Object.freeze([]),
  });
}

/**
 * Advance an offline publication by validating accepted complete stages and
 * returning the exact next-stage bytes. No upload, receipt creation, or
 * transport action is performed here.
 */
export async function advanceCreatorPublication(
  prepared: CreatorPreparedPublication,
  receipts: readonly CreatorPublicationReceipt[],
): Promise<CreatorPublicationAdvance> {
  const progress = await progressCreatorPublication(prepared, receipts);
  return Object.freeze({
    schema: "keel-creator-publication-advance@1",
    acceptedNodeKeys: progress.acceptedNodeKeys,
    readyStage: progress.readyStage,
    ready: progress.ready,
  });
}

/**
 * Validates every staged receipt, substitutes only its parsed consumer edge,
 * and recomputes each parent before accepting its receipt. This is entirely
 * offline: callers receive the next bytes to publish but no upload is issued.
 */
export async function finalizeCreatorPublication(
  prepared: CreatorPreparedPublication,
  receipts: readonly CreatorPublicationReceipt[],
): Promise<CreatorResolvedPublication> {
  const progress = await progressCreatorPublication(prepared, receipts);
  if (progress.readyStage !== null) throw new TypeError("creator publication finalization requires every logical node receipt.");
  const resolvedByKey = new Map(progress.resolved.map((node) => [node.key, node]));
  const aliases = new Map(progress.resolved.map((node) => [node.key, node.alias]));
  const edges = Object.freeze(prepared.edges.map((edge) => Object.freeze({ ...edge, resolvedAlias: aliases.get(edge.dependency)! })));
  const roots = Object.freeze(prepared.roots.map((key) => resolvedByKey.get(key)!).sort((left, right) => left.key.localeCompare(right.key)));
  return Object.freeze({ schema: "keel-creator-resolved-publication@1", nodes: progress.resolved, edges, stages: prepared.stages, roots });
}

/**
 * Produces the transport-safe form of prepared data. Runtime publications keep
 * Uint8Array values for hashing and must not be sent through JSON directly.
 */
export function serializeCreatorPreparedPublication(prepared: CreatorPreparedPublication): CreatorPreparedPublicationJson {
  if (prepared.schema !== "keel-creator-staged-publication@1") throw new TypeError("unsupported staged creator publication schema.");
  return Object.freeze({
    schema: prepared.schema,
    nodes: Object.freeze(prepared.nodes.map(jsonLogicalObject)),
    edges: Object.freeze(prepared.edges.map((edge) => Object.freeze({
      consumer: edge.consumer,
      dependency: edge.dependency,
      localSpecifier: edge.localSpecifier,
      sourceEdges: Object.freeze(edge.sourceEdges.map((source) => Object.freeze({ consumer: source.consumer, dependency: source.dependency }))),
    }))),
    stages: Object.freeze(prepared.stages.map((stage) => Object.freeze({ index: stage.index, nodeKeys: Object.freeze([...stage.nodeKeys]) }))),
    roots: Object.freeze([...prepared.roots]),
  });
}

/** Produces the transport-safe form of an advance response. */
export function serializeCreatorPublicationAdvance(advance: CreatorPublicationAdvance): CreatorPublicationAdvanceJson {
  if (advance.schema !== "keel-creator-publication-advance@1") throw new TypeError("unsupported creator publication advance schema.");
  return Object.freeze({
    schema: advance.schema,
    acceptedNodeKeys: Object.freeze([...advance.acceptedNodeKeys]),
    readyStage: advance.readyStage === null ? null : Object.freeze({ index: advance.readyStage.index, nodeKeys: Object.freeze([...advance.readyStage.nodeKeys]) }),
    ready: Object.freeze(advance.ready.map(jsonReadyObject)),
  });
}

/** Produces the transport-safe form of resolved data. */
export function serializeCreatorResolvedPublication(resolved: CreatorResolvedPublication): CreatorResolvedPublicationJson {
  if (resolved.schema !== "keel-creator-resolved-publication@1") throw new TypeError("unsupported resolved creator publication schema.");
  return Object.freeze({
    schema: resolved.schema,
    nodes: Object.freeze(resolved.nodes.map(jsonResolvedObject)),
    edges: Object.freeze(resolved.edges.map((edge) => Object.freeze({
      consumer: edge.consumer,
      dependency: edge.dependency,
      localSpecifier: edge.localSpecifier,
      sourceEdges: Object.freeze(edge.sourceEdges.map((source) => Object.freeze({ consumer: source.consumer, dependency: source.dependency }))),
      resolvedAlias: edge.resolvedAlias,
    }))),
    stages: Object.freeze(resolved.stages.map((stage) => Object.freeze({ index: stage.index, nodeKeys: Object.freeze([...stage.nodeKeys]) }))),
    roots: Object.freeze(resolved.roots.map(jsonResolvedObject)),
  });
}
