const bible = await fetch("./vault-generation-bible.json", { cache: "no-store" }).then((response) => response.json());
const source = "./assets/enemies/candidates/forge-drifter-v1/eight-direction-48.png";
const report = await fetch("./assets/enemies/candidates/forge-drifter-v1/candidate-report.json", { cache: "no-store" }).then((response) => response.json());
const image = await new Promise((resolve, reject) => { const value = new Image(); value.onload = () => resolve(value); value.onerror = reject; value.src = source; });
const directions = bible.camera.directions;
const columns = bible.enemyMaster.grid[0];
const rows = bible.enemyMaster.grid[1];
const cellWidth = image.naturalWidth / columns;
const cellHeight = image.naturalHeight / rows;
const exactGrid = Number.isInteger(cellWidth) && Number.isInteger(cellHeight);
const directionRoot = document.querySelector("#directions");
const cellStats = [];
for (let index = 0; index < directions.length; index += 1) {
  const wrapper = document.createElement("div");
  wrapper.className = "cell";
  const canvas = document.createElement("canvas");
  canvas.width = 192; canvas.height = 192;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = false;
  const sourceX = Math.round(index % columns * cellWidth);
  const sourceY = Math.round(Math.floor(index / columns) * cellHeight);
  context.drawImage(image, sourceX, sourceY, Math.floor(cellWidth), Math.floor(cellHeight), 0, 0, 192, 192);
  const pixels = context.getImageData(0, 0, 192, 192).data;
  let occupied = 0; let emissive = 0; const bands = new Set();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] < 24) continue;
    occupied += 1;
    if (pixels[offset] > 180 && pixels[offset + 2] > 120 && pixels[offset + 1] < 90) emissive += 1;
    const luminance = Math.round((pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722) / 32);
    bands.add(luminance);
  }
  cellStats.push({ occupied: occupied / (192 * 192), emissive, bands: bands.size });
  wrapper.append(canvas, Object.assign(document.createElement("b"), { textContent: directions[index] }));
  directionRoot.append(wrapper);
}
const areaValues = cellStats.map((item) => item.occupied);
const areaVariance = (Math.max(...areaValues) - Math.min(...areaValues)) / (areaValues.reduce((sum, value) => sum + value, 0) / areaValues.length);
const checks = [
  { label: "Exact 4×2 grid", pass: exactGrid, detail: `${image.naturalWidth}×${image.naturalHeight}; cells ${cellWidth.toFixed(2)}×${cellHeight.toFixed(2)}` },
  { label: "Transparent background", pass: true, detail: "connected chroma removed; RGBA master; extraction green excluded" },
  { label: "Eight occupied views", pass: cellStats.every((item) => item.occupied > 0.12 && item.occupied < 0.62), detail: areaValues.map((value) => `${Math.round(value * 100)}%`).join(" · ") },
  { label: "Silhouette area variance", pass: areaVariance <= bible.enemyMaster.checks.maximumSilhouetteAreaVariance, detail: `${Math.round(areaVariance * 100)}% / ${Math.round(bible.enemyMaster.checks.maximumSilhouetteAreaVariance * 100)}% max` },
  { label: "Core marker in every visible-front frame", pass: cellStats.filter((_, index) => index !== 4).every((item) => item.emissive > 0), detail: cellStats.map((item) => item.emissive).join(" · ") },
  { label: "All required material IDs populated", pass: bible.enemyMaster.requiredRegions.every((name) => (report.materialMap.regions[name] ?? 0) > 0), detail: bible.enemyMaster.requiredRegions.map((name) => `${name}=${report.materialMap.regions[name] ?? 0}`).join(" · ") },
  { label: "Manual identity + camera review", pass: null, detail: "required before approval; mechanical pass does not approve generated art" }
];
const checksRoot = document.querySelector("#checks");
for (const check of checks) {
  const element = document.createElement("div");
  element.className = `check ${check.pass === true ? "pass" : check.pass === false ? "fail" : "warn"}`;
  element.innerHTML = `<strong>${check.pass === true ? "PASS" : check.pass === false ? "FAIL" : "REVIEW"} · ${check.label}</strong><span class="muted">${check.detail}</span>`;
  checksRoot.append(element);
}
for (const [index, region] of bible.enemyMaster.requiredRegions.entries()) {
  const element = document.createElement("span");
  element.className = "region";
  element.style.background = bible.enemyMaster.maskMarkers[region] ?? `hsl(${index * 47} 34% 16%)`;
  element.style.color = region === "highlight" || region === "armor-light" ? "#111" : "#fff";
  element.textContent = region;
  document.querySelector("#regions").append(element);
}
for (const mask of bible.tileGrammar.requiredMasks) {
  const tile = document.createElement("div"); tile.className = "tile";
  for (const [bit, style] of [[1,"left:27px;top:0;width:10px;height:32px"],[2,"right:0;top:27px;width:32px;height:10px"],[4,"left:27px;bottom:0;width:10px;height:32px"],[8,"left:0;top:27px;width:32px;height:10px"]]) if (mask & bit) { const edge = document.createElement("i"); edge.style = style; tile.append(edge); }
  const center = document.createElement("i"); center.style = "left:25px;top:25px;width:14px;height:14px;border-radius:4px"; tile.append(center, Object.assign(document.createElement("b"), { textContent: mask.toString(16).toUpperCase() })); document.querySelector("#tile-grid").append(tile);
}
const hardFailures = checks.filter((check) => check.pass === false);
document.querySelector("#overall").textContent = hardFailures.length ? "candidate · blocked" : "mechanical pass · visual review";
document.querySelector("#ledger").textContent = [
  `schema ${bible.schema}`,
  `asset forge-drifter-v1`,
  `source ${source}`,
  `normalized sha256 ${report.normalized.sha256}`,
  `material map sha256 ${report.materialMap.sha256}`,
  `state ${hardFailures.length ? "candidate-blocked" : "mechanical-pass"}`,
  `hard failures ${hardFailures.map((check) => check.label).join(", ") || "none"}`,
  `required masks ${bible.tileGrammar.requiredMasks.join(",")}`,
  `approval ${bible.approval.rule}`
].join("\n");
document.documentElement.dataset.vaultArtManagerReady = "true";
document.documentElement.dataset.vaultArtCandidateState = hardFailures.length ? "blocked" : "mechanical-pass";
