const { chromium } = require("playwright");

const root = "/Users/ravonus/dev/oca-modern";
const url = "http://127.0.0.1:4186/vault-game.html?mapSeed=vault-gauntlet-0001&characterSeed=orb-character-001&v=weapon-material-live-1";

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator("#start-run").click();
  await page.waitForFunction(() => document.documentElement.dataset.vaultGameReady === "true");
  await page.waitForTimeout(600);
  const gamePath = `${root}/vault-live-weapon-material-game.png`;
  const loadoutPath = `${root}/vault-live-weapon-material-loadout.png`;
  await page.locator("#game").screenshot({ path: gamePath });
  await page.locator(".sidebar").nth(1).screenshot({ path: loadoutPath });
  const proof = await page.evaluate(() => ({
    weapon: document.documentElement.dataset.vaultWeapon,
    materials: document.documentElement.dataset.vaultWeaponMaterials,
    coreLink: document.documentElement.dataset.vaultWeaponCoreLink,
    preview: document.querySelector("#weapon-preview")?.getAttribute("src")?.slice(0, 32),
  }));
  console.log(JSON.stringify({ proof, errors, screenshots: [gamePath, loadoutPath] }, null, 2));
  await browser.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
