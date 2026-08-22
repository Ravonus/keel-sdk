import { chromium } from "../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
await page.goto("http://127.0.0.1:4186/vault-game.html?mapSeed=vault-gauntlet-0001&characterSeed=gyro-proof-2&autostart=1&v=responsive-landscape-script-1", { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const move = await page.locator("#touch-move").boundingBox();
await page.mouse.move(move.x + move.width / 2, move.y + move.height / 2);
await page.mouse.down();
await page.mouse.move(move.x + move.width * 0.82, move.y + move.height * 0.28, { steps: 4 });
const moveState = await page.evaluate(() => document.documentElement.dataset.vaultTouchVector);
await page.mouse.up();

const aim = await page.locator("#touch-aim").boundingBox();
await page.mouse.move(aim.x + aim.width / 2, aim.y + aim.height / 2);
await page.mouse.down();
await page.mouse.move(aim.x + aim.width * 0.86, aim.y + aim.height * 0.5, { steps: 4 });
await page.waitForTimeout(160);
const aimState = await page.evaluate(() => ({
  vector: document.documentElement.dataset.vaultTouchVector,
  gyro: document.documentElement.dataset.vaultGyroProjectile,
}));
await page.screenshot({ path: "vault-responsive-landscape-current.png" });
await page.mouse.up();
const receipt = await page.evaluate(() => ({
  viewport: [innerWidth, innerHeight],
  release: document.documentElement.dataset.vaultTouchVector,
  body: [document.body.scrollWidth, document.body.clientWidth],
  controls: document.documentElement.dataset.vaultTouchControls,
}));

console.log(JSON.stringify({ ...receipt, moveState, aimState, errors }, null, 2));
await browser.close();

