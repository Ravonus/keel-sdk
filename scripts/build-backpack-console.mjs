/**
 * Build the backpack console against a deployment record.
 *
 * Split out from the deploy so the page can be rebuilt after an edit without
 * re-running sixty-five transactions. Addresses are inlined at build time, so a
 * built console can only ever drive the deployment it was built for.
 *
 *   node scripts/build-backpack-console.mjs [record.json] [out.html]
 */
import { readFileSync, writeFileSync } from "node:fs";

const record = process.argv[2] ?? "scripts/backpack-demo-sepolia.json";
const out = process.argv[3] ?? "packages/viewer/app/console.built.html";
const deployment = JSON.parse(readFileSync(record, "utf8"));

// What each token's metadata names as its artwork. The console recomputes the
// same CID from whatever file it is handed, so a mismatch is visible before any
// transaction is signed — a CID is the hash of the bytes, not a label attached
// to them, and that is a sum anyone can do for themselves.
deployment.cids ??= {
  1: "QmPbxeGcXhYQQNgsC6a36dDyYUcHgMLnGKnF8pVFmGsvqi",
  2: "QmcJYkCKK7QPmYWjp4FD2e3Lv5WCGFuHNUByvGKBaytif4",
  3: "QmYxT4LnK8sqLupjbS6eRvu1si7Ly2wFQAqFebxhWntcf6",
  4: "QmSg9bPzW9anFYc3wWU5KnvymwkxQTpmqcRSfYj7UmiBa7",
  5: "QmNwbd7ctEhGpVkP8nZvBBQfiNeFKRdxftJAxxEdkUKLcQ",
};
deployment.route ??= "ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/{id}";

const html = readFileSync("packages/viewer/app/console.html", "utf8");
if (!html.includes("__DEPLOYMENT__")) throw new Error("console.html has no __DEPLOYMENT__ placeholder");
writeFileSync(out, html.replace("__DEPLOYMENT__", JSON.stringify(deployment)));

console.log(`${out}`);
console.log(`  backpack   ${deployment.backpack}`);
console.log(`  ledger     ${deployment.ledger}`);
console.log(`  tokens     ${deployment.tokens.map((t) => `#${t.id}`).join(" ")}`);
