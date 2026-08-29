/**
 * Replace verified module aliases without allowing a short alias to corrupt a
 * longer path alias (for example seeded-random.js inside /content/seeded-random.js).
 */
export function replaceVerifiedAliases(text, aliases) {
  let result = text;
  const ordered = [...aliases].sort(([left], [right]) => (
    right.length - left.length || left.localeCompare(right)
  ));
  for (const [alias, url] of ordered) result = result.replaceAll(alias, url);
  return result;
}
