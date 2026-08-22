declare const process: {
  pid: number;
  kill(pid: number, signal?: number | string): boolean;
  argv: string[];
  cwd(): string;
  exit(code?: number): never;
  exitCode?: number;
  env: Record<string, string | undefined>;
  stdout: { write(value: string): void };
  stderr: { write(value: string): void };
};

declare class Buffer extends Uint8Array {
  static from(value: string | ArrayBuffer | ArrayLike<number>, encoding?: string): Buffer;
  static concat(values: readonly Uint8Array[]): Buffer;
  static byteLength(value: string, encoding?: string): number;
  toString(encoding?: string): string;
}

declare module "node:fs/promises" {
  export function readFile(path: string | URL, encoding: "utf8" | "utf-8"): Promise<string>;
  export function readFile(path: string | URL): Promise<Buffer>;
  export function writeFile(path: string | URL, data: string | Uint8Array, encoding?: "utf8" | "utf-8"): Promise<void>;
  export function mkdir(path: string | URL, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function rm(path: string | URL, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function cp(source: string | URL, destination: string | URL, options?: { recursive?: boolean }): Promise<void>;
  export function copyFile(source: string | URL, destination: string | URL): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function realpath(path: string | URL): Promise<string>;
  export function rename(oldPath: string | URL, newPath: string | URL): Promise<void>;
  export function stat(path: string | URL): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number }>;
  export function readdir(path: string | URL, options: { withFileTypes: true }): Promise<Array<{ name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>>;
  export function readdir(path: string | URL, options?: { withFileTypes?: false }): Promise<string[]>;
  export function access(path: string | URL): Promise<void>;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  export function extname(path: string): string;
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(path: string): boolean;
  export const sep: string;
  const path: {
    resolve: typeof resolve;
    dirname: typeof dirname;
    basename: typeof basename;
    extname: typeof extname;
    join: typeof join;
    relative: typeof relative;
    isAbsolute: typeof isAbsolute;
    sep: typeof sep;
  };
  export default path;
}

declare module "node:url" {
  export function pathToFileURL(path: string): URL;
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): unknown;
    digest(encoding?: string): any;
  };
}

declare module "node:zlib" {
  export function brotliCompress(data: Uint8Array, options: unknown, callback: (error: Error | null, result: Buffer) => void): void;
  export function brotliDecompress(data: Uint8Array, callback: (error: Error | null, result: Buffer) => void): void;
  export function gzip(data: Uint8Array, options: unknown, callback: (error: Error | null, result: Buffer) => void): void;
  export function gunzip(data: Uint8Array, callback: (error: Error | null, result: Buffer) => void): void;
  export function deflate(data: Uint8Array, options: unknown, callback: (error: Error | null, result: Buffer) => void): void;
  export function inflate(data: Uint8Array, callback: (error: Error | null, result: Buffer) => void): void;
  export const constants: Record<string, number>;
}

declare module "node:util" {
  export function promisify<T extends (...args: any[]) => any>(fn: T): (...args: any[]) => Promise<any>;
}

declare module "node:test" {
  type TestFunction = (name: string, fn: () => unknown | Promise<unknown>) => void;
  const test: TestFunction;
  export default test;
  export { test };
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, expected?: RegExp | ((error: unknown) => boolean)): void;
    rejects(fn: () => Promise<unknown>, expected?: RegExp | ((error: unknown) => boolean)): Promise<void>;
  };
  export default assert;
}

declare module "sharp" {
  interface SharpInstance {
    webp(options?: { quality?: number; effort?: number; lossless?: boolean; smartSubsample?: boolean }): SharpInstance;
    composite(inputs: Array<{ input: string | Uint8Array; left?: number; top?: number }>): SharpInstance;
    png(options?: unknown): SharpInstance;
    resize(width?: number, height?: number, options?: unknown): SharpInstance;
    extract(options: { left: number; top: number; width: number; height: number }): SharpInstance;
    toFile(path: string): Promise<{ size: number; width?: number; height?: number }>;
    toBuffer(): Promise<Buffer>;
    metadata(): Promise<{ width?: number; height?: number; format?: string }>;
    ensureAlpha(): SharpInstance;
    raw(): SharpInstance;
  }
  interface SharpFactory {
    (input?: string | Uint8Array | { create: { width: number; height: number; channels: number; background: string | { r: number; g: number; b: number; alpha?: number } } }, options?: { raw?: { width: number; height: number; channels: number } }): SharpInstance;
  }
  const sharp: SharpFactory;
  export default sharp;
}
