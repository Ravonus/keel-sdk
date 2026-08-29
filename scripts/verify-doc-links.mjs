import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { root } from "./run.mjs";

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "artifacts"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(absolute));
    else if (entry.isFile() && entry.name.endsWith(".md")) output.push(absolute);
  }
  return output;
}

const failures = [];
const pattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
for (const file of await walk(root)) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(pattern)) {
    const raw = match[1]?.trim() ?? "";
    const target = raw.replace(/^<|>$/g, "").split("#", 1)[0] ?? "";
    if (!target || /^(?:https?:|mailto:|data:|ipfs:|ar:|keel:)/i.test(target)) continue;
    const decoded = decodeURIComponent(target);
    const resolved = path.resolve(path.dirname(file), decoded);
    try {
      await access(resolved);
    } catch {
      failures.push(`${path.relative(root, file)} -> ${target}`);
    }
  }
}
if (failures.length > 0) {
  console.error(`Broken local Markdown links:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("Local Markdown links verified.");
