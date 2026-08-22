import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OCA_APPEND_ONLY_TRAIT_BITS_CODEC,
  encodeMaterialBits,
  encodeTraitCatalogBits,
  traitCombinationCount,
} from "../../../packages/viewer/dist/index.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(await readFile(path.join(directory, "character-catalog.source.json"), "utf8"));
const materials = JSON.parse(await readFile(path.join(directory, "character-materials.source.json"), "utf8"));
const options = source.weightCurve;
const catalog = {
  codec: OCA_APPEND_ONLY_TRAIT_BITS_CODEC,
  revision: source.revision,
  rejectExactDuplicates: source.rejectExactDuplicates,
  attributes: source.attributeFamilies.map((attribute) => ({
    attributeId: attribute.attributeId,
    introducedAt: source.revision,
    entropyDomain:
      (Math.imul(attribute.attributeId + 1, 0x9e3779b1) ^
        Math.imul(attribute.attributeId + 1, 0x85ebca6b)) >>>
      0,
    ...(attribute.coreSlot === undefined ? {} : { coreSlot: attribute.coreSlot }),
    required: attribute.required === true,
    options: Array.from({ length: attribute.optionCount }, (_, optionId) => ({
      optionId,
      weight: options[optionId],
      materialProfileId: optionId % materials.profiles.length,
      introducedAt: source.revision,
    })),
  })),
};

await writeFile(path.join(directory, "character-catalog.json"), `${JSON.stringify({
  ...catalog,
  labels: Object.fromEntries(source.attributeFamilies.map((attribute) => [attribute.attributeId, attribute.name])),
}, null, 2)}\n`);
await writeFile(path.join(directory, "character-catalog.octr"), encodeTraitCatalogBits(catalog));
for (const profile of materials.profiles) {
  await writeFile(path.join(directory, `character-material-${profile.setId}.ocmp`), encodeMaterialBits(profile));
}

console.log(
  `Built ${catalog.attributes.length} extensible attributes, ${traitCombinationCount(catalog).toString()} discrete trait combinations, and ${materials.profiles.length} compact material sets.`,
);
