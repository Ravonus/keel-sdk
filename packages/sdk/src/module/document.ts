import type { DeclaredModule } from "./define.js";
import type { ModuleDescriptor } from "./descriptor.js";

export interface ModuleDocumentContext {
  readonly root: HTMLElement;
  readonly document: Document;
}

export interface TrustedHtml {
  readonly kind: "keel-trusted-html@1";
  readonly source: string;
}

export interface ModuleDocumentDeclaration {
  readonly kind: "keel-module-document@1";
  readonly title: string;
  readonly lang: string;
  readonly mountId: string;
  readonly head?: TrustedHtml;
  readonly render: (context: ModuleDocumentContext) => void | Promise<void>;
}

const TRUSTED_HTML = new WeakSet<object>();
const MODULE_DOCUMENTS = new WeakSet<object>();

/** An explicit escape hatch for creator-owned markup that belongs in `<head>`. */
export function trustedHtml(source: string): TrustedHtml {
  if (typeof source !== "string" || source.trim() === "") throw new TypeError("trusted HTML must be a nonempty string.");
  const value = Object.freeze({ kind: "keel-trusted-html@1" as const, source });
  TRUSTED_HTML.add(value);
  return value;
}

export function defineDocument(input: {
  readonly title: string;
  readonly lang?: string;
  readonly mountId?: string;
  readonly head?: TrustedHtml;
  readonly render: (context: ModuleDocumentContext) => void | Promise<void>;
}): ModuleDocumentDeclaration {
  if (typeof input.title !== "string" || input.title.trim() === "") throw new TypeError("a document needs a title.");
  const lang = input.lang ?? "en";
  const mountId = input.mountId ?? "app";
  if (typeof lang !== "string" || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(lang)) {
    throw new TypeError("document lang must be a valid language tag.");
  }
  if (typeof mountId !== "string" || !/^[A-Za-z][A-Za-z0-9_:-]*$/u.test(mountId)) {
    throw new TypeError("document mountId must be a valid nonempty element id.");
  }
  if (typeof input.render !== "function") throw new TypeError("document render must be a function.");
  if (input.head !== undefined && !TRUSTED_HTML.has(input.head)) {
    throw new TypeError("document head must be created with trustedHtml().");
  }
  const value = Object.freeze({
    kind: "keel-module-document@1" as const,
    title: input.title,
    lang,
    mountId,
    ...(input.head === undefined ? {} : { head: input.head }),
    render: input.render,
  });
  MODULE_DOCUMENTS.add(value);
  return value;
}

export function isModuleDocument(value: unknown): value is ModuleDocumentDeclaration {
  return typeof value === "object" && value !== null && MODULE_DOCUMENTS.has(value);
}

/** Browser entry helper. It never resolves module APIs or crosses a sandbox boundary. */
export async function mountModuleDocument<Descriptors extends readonly ModuleDescriptor[]>(
  declaration: DeclaredModule<Descriptors>,
): Promise<void> {
  const moduleDocument = declaration.document;
  if (moduleDocument === undefined || !isModuleDocument(moduleDocument)) {
    throw new TypeError("module document must be created with defineDocument().");
  }
  document.title = moduleDocument.title;
  document.documentElement.lang = moduleDocument.lang;
  if (moduleDocument.head !== undefined) document.head.insertAdjacentHTML("beforeend", moduleDocument.head.source);
  let root = document.getElementById(moduleDocument.mountId);
  if (root === null) {
    root = document.createElement("div");
    root.id = moduleDocument.mountId;
    document.body.append(root);
  }
  await moduleDocument.render({ root, document });
}
