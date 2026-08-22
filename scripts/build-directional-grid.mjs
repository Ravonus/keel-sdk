#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createDirectionalAnimationAtlas,
  encodeSpriteBitAtlas,
} from "../packages/viewer/dist/index.js";

const outputBase = path.resolve(
  process.argv[2] ?? "directional-attribute-grid",
);
const layout = createDirectionalAnimationAtlas({
  frameWidth: 48,
  frameHeight: 48,
  directions: ["south", "west", "north", "east"],
  clips: [
    { id: "idle", frames: 4, fps: 6 },
    { id: "walk", frames: 6, fps: 10 },
    { id: "attack", frames: 8, fps: 12 },
    { id: "hit", frames: 3, fps: 12 },
    { id: "death", frames: 8, fps: 8 },
  ],
});

const labelWidth = 124;
const width = layout.imageWidth + labelWidth;
const rowMarkup = layout.rows
  .map((row) => {
    const y = row.row * 48;
    const cells = Array.from({ length: layout.columns }, (_, column) => {
      const active = column < row.frameCount;
      return `<rect x="${labelWidth + column * 48}" y="${y}" width="48" height="48" fill="${active ? ((row.row + column) % 2 === 0 ? "#172033" : "#101725") : "#080b12"}" stroke="${active ? "#52627f" : "#242a36"}"/><text x="${labelWidth + column * 48 + 5}" y="${y + 14}" fill="${active ? "#b8c8e8" : "#465066"}" font-size="9">${column}</text>`;
    }).join("");
    return `<text x="8" y="${y + 20}" fill="#f2f5ff" font-size="12" font-weight="700">${row.clipId}</text><text x="8" y="${y + 36}" fill="#8fa2c6" font-size="10">${row.direction} · ${row.frameCount}f</text>${cells}`;
  })
  .join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${layout.imageHeight}" viewBox="0 0 ${width} ${layout.imageHeight}"><rect width="100%" height="100%" fill="#070a10"/>${rowMarkup}</svg>`;

await writeFile(`${outputBase}.svg`, svg);
await writeFile(
  `${outputBase}.json`,
  `${JSON.stringify(
    {
      schema: "oca-directional-attribute-grid@1",
      frameWidth: 48,
      frameHeight: 48,
      imageWidth: layout.imageWidth,
      imageHeight: layout.imageHeight,
      columns: layout.columns,
      rows: layout.rows,
      frameCount: layout.atlas.frames.length,
    },
    null,
    2,
  )}\n`,
);
await writeFile(`${outputBase}.ocaa`, encodeSpriteBitAtlas(layout.atlas));
console.log(
  JSON.stringify(
    {
      outputBase,
      dimensions: [layout.imageWidth, layout.imageHeight],
      rows: layout.rows.length,
      frames: layout.atlas.frames.length,
    },
    null,
    2,
  ),
);
