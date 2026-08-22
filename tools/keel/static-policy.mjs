/**
 * The Solidity source policy, shared by the repo-wide gate
 * (scripts/solidity-static-check.mjs) and the per-module gate (keel verify) so
 * the two cannot drift apart.
 */

export const FORBIDDEN = [
  ["tx.origin", /\btx\.origin\b/],
  ["raw ecrecover", /\becrecover\s*\(/],
  ["delegatecall", /\.delegatecall\s*\(/],
  ["selfdestruct", /\bselfdestruct\s*\(/],
  ["Hardhat console", /hardhat\/console\.sol/],
  ["blockhash randomness", /blockhash\s*\(/],
];

export const REQUIRED_PRAGMA = "pragma solidity 0.8.36;";

/**
 * blockhash is forbidden as a source of entropy. Binding a previously observed
 * block as evidence is legitimate and unavoidable, so it is allowed only where
 * the call carries an inline annotation naming a reason from this set — an
 * explicit, greppable, reviewable opt-out rather than a silent exception.
 */
export const BLOCKHASH_ALLOWED_REASONS = new Set([
  // comparing a recorded block hash to the chain's, to detect a reorg
  "evidence-block-equality",
  // sealing an already-observed block's hash into storage as proof
  "evidence-block-seal",
]);

const ANNOTATED_BLOCKHASH = /blockhash\s*\([^()]*\)\s*\/\*\s*static-policy-allow:\s*([a-z-]+)\s*\*\//gu;

export function staticPolicyCode(source) {
  const policySource = source.replace(ANNOTATED_BLOCKHASH, (whole, reason) =>
    // an unrecognised reason is left in place, so the scan still rejects it
    (BLOCKHASH_ALLOWED_REASONS.has(reason) ? "bytes32(0)" : whole),
  );
  return stripComments(policySource);
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Braces inside string literals and comments are not structure. This must be a
 * single pass: stripping comments first eats the closing quote of any string
 * containing `//` (every https:// URL), and stripping strings first eats the
 * quote characters that appear inside comments.
 */
export function structuralCode(source) {
  let out = "";
  let state = "code"; // code | line | block | string
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "line") {
      if (ch === "\n") { state = "code"; out += ch; }
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") { state = "code"; i += 1; }
      continue;
    }
    if (state === "string") {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) { state = "code"; quote = null; }
      continue;
    }
    if (ch === "/" && next === "/") { state = "line"; i += 1; continue; }
    if (ch === "/" && next === "*") { state = "block"; i += 1; continue; }
    if (ch === '"' || ch === "'") { state = "string"; quote = ch; continue; }
    out += ch;
  }
  return out;
}

/** @returns {string[]} human-readable findings; empty means the file passes. */
export function checkSource(source) {
  const findings = [];
  if (!source.includes(REQUIRED_PRAGMA)) findings.push("compiler must be pinned to 0.8.36");
  const code = staticPolicyCode(source);
  for (const [label, pattern] of FORBIDDEN) {
    if (pattern.test(code)) findings.push(`forbidden pattern ${label}`);
  }
  const structural = structuralCode(source);
  const opening = [...structural].filter((v) => v === "{").length;
  const closing = [...structural].filter((v) => v === "}").length;
  if (opening !== closing) findings.push(`unbalanced braces (${opening}/${closing})`);
  return findings;
}
