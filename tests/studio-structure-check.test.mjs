import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Studio structure accepts canonical and idempotent Drizzle CREATE TABLE migrations", async () => {
  const [checker, migration] = await Promise.all([
    readFile(new URL("../scripts/studio-structure-check.mjs", import.meta.url), "utf8"),
    readFile(new URL("../apps/studio/drizzle/0004_vault_character_index.sql", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "indexed_vault_catalogs"/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "indexed_vault_characters"/u);
  assert.match(checker, /CREATE TABLE\(\?: IF NOT EXISTS\)\?/u);
  const result = spawnSync(process.execPath, ["scripts/studio-structure-check.mjs"], {
    cwd: process.cwd(), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Studio structure passed/u);
});
