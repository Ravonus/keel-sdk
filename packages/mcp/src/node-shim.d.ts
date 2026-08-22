declare module "node:fs/promises" {
  export function writeFile(path: string | URL, data: string | Uint8Array, options?: { flag?: string; encoding?: "utf8" | "utf-8" }): Promise<void>;
}
