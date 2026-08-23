const { chromium } = require("playwright");

const root = "/Users/ravonus/dev/keel-sdk";
const base = "http://127.0.0.1:4186/vault-game.html";
const reviews = [
  ["material-review-2", ""],
  ["material-review-5", ""],
  ["material-review-8", ""],
  ["material-review-45", ""],
  ["material-review-2", "&wallReview=1"],
  ["material-review-2", "&reviewDoor=1&doorReviewProgress=0"],
  ["material-review-2", "&reviewDoor=1&doorReviewProgress=0.5"],
  ["material-review-2", "&reviewDoor=1&doorReviewProgress=1"],
];

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
  const results = [];
  for (let index = 0; index < reviews.length; index += 1) {
    const [seed, suffix] = reviews[index];
    const url = `${base}?mapSeed=${seed}&characterSeed=orb-character-001&artReview=1&v=material-v10${suffix}`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator("#start-run").click();
    await page.waitForFunction(() => document.documentElement.dataset.vaultGameReady === "true");
    await page.waitForTimeout(350);
    const label = index < 4 ? seed : index === 4 ? "walls" : `door-${["locked", "half", "open"][index - 5]}`;
    const path = `${root}/vault-material-v10-${label}.png`;
    await page.locator("#game").screenshot({ path });
    results.push({ label, path, biome: await page.locator("html").getAttribute("data-vault-biome") });
  }
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
