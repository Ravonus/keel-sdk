// Readable source in, smallest honest artifact out. The source is what a human
// reviews; the minified build is what the chain pays for, so it is worth being
// ruthless about — every byte is ~225 gas, forever.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, "keel-viewer.min.html");

const js = await build({
  entryPoints: [join(here, "viewer-app.js")],
  bundle: true, minify: true, format: "iife", target: ["es2022"], write: false,
  legalComments: "none",
});
const css = await build({
  stdin: { contents: readFileSync(join(here, "viewer-app.css"), "utf8"), loader: "css" },
  minify: true, write: false,
});
const html = readFileSync(join(here, "viewer-app.html"), "utf8")
  .replace("__CSS__", css.outputFiles[0].text.trim())
  .replace("__JS__", js.outputFiles[0].text.trim())
  .replace(/\n\s*/g, "");

// The document is a KeelHold composite of ordered parts:
//
//   [ head , body , artwork , tail ]
//
// `head` must end with the context slot the builder splices this token's own
// facts into. `artwork` is the preserved bytes themselves, referenced rather
// than copied — the object already exists on chain once, and every document
// that shows it points at that same object.
const SLOT = "<!--@keel:context-->";
const slotAt = html.indexOf(SLOT);
if (slotAt < 0) throw new Error("viewer-app.html has no context slot");
const head = html.slice(0, slotAt + SLOT.length);
const rest = html.slice(slotAt + SLOT.length);
const [body, tail] = rest.split("__ART__");
if (tail === undefined) throw new Error("viewer-app.html has no __ART__ slot");

writeFileSync(out, html.replace("__ART__", ""));
const base = out.replace(/\.html$/, "");
writeFileSync(`${base}.head.html`, head);
writeFileSync(`${base}.body.html`, body);
writeFileSync(`${base}.tail.html`, tail);

const source = ["viewer-app.js", "viewer-app.css", "viewer-app.html"]
  .reduce((total, file) => total + readFileSync(join(here, file)).length, 0);
console.log(`source   ${source.toLocaleString()} B`);
console.log(`minified ${html.length.toLocaleString()} B  (${(100 - (html.length / source) * 100).toFixed(1)}% smaller)`);
console.log(`chunks   ${Math.ceil(html.length / 23000)}  ·  ~${((html.length * 225) / 1e6).toFixed(1)}M gas to store`);
console.log(
  `parts    head ${head.length.toLocaleString()} B · body ${body.length.toLocaleString()} B` +
    ` · <artwork> · tail ${tail.length.toLocaleString()} B`,
);
