import { chromium } from "../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs";

const base = "http://127.0.0.1:4186/vault-game.html";
const browser = await chromium.launch({ headless: true });

async function openTouchPage(viewport, query) {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}?${query}`, { waitUntil: "networkidle" });
  return { context, page, errors };
}

const portrait = await openTouchPage(
  { width: 390, height: 844 },
  "mapSeed=visual-biome-0&characterSeed=orb-character-001&reviewStation=1&v=responsive-script-1",
);
await portrait.page.getByText("Enter staked map").click();
await portrait.page.waitForTimeout(450);
if (await portrait.page.getByText("Enter staked map").count()) await portrait.page.getByText("Enter staked map").click();
await portrait.page.waitForTimeout(550);
await portrait.page.screenshot({ path: "vault-responsive-portrait-current.png" });
const portraitReceipt = await portrait.page.evaluate(() => {
  const card = document.querySelector(".shop-card");
  const stage = document.querySelector(".stage");
  const touch = document.querySelector("#touch-controls");
  return {
    viewport: [innerWidth, innerHeight],
    stage: [stage.clientWidth, stage.clientHeight],
    touch: getComputedStyle(touch).display,
    station: document.querySelector("#shop").className,
    card: { clientHeight: card.clientHeight, scrollHeight: card.scrollHeight, top: card.getBoundingClientRect().top, bottom: card.getBoundingClientRect().bottom },
    body: [document.body.scrollWidth, document.body.clientWidth],
    data: document.documentElement.dataset.vaultTouchControls,
  };
});
await portrait.context.close();

const landscape = await openTouchPage(
  { width: 844, height: 390 },
  "mapSeed=vault-gauntlet-0001&characterSeed=gyro-proof-2&autostart=1&v=responsive-script-1",
);
await landscape.page.waitForTimeout(800);
const move = await landscape.page.locator("#touch-move").boundingBox();
await landscape.page.mouse.move(move.x + move.width / 2, move.y + move.height / 2);
await landscape.page.mouse.down();
await landscape.page.mouse.move(move.x + move.width * 0.82, move.y + move.height * 0.28, { steps: 4 });
const moveState = await landscape.page.evaluate(() => document.documentElement.dataset.vaultTouchVector);
await landscape.page.mouse.up();
const aim = await landscape.page.locator("#touch-aim").boundingBox();
await landscape.page.mouse.move(aim.x + aim.width / 2, aim.y + aim.height / 2);
await landscape.page.mouse.down();
await landscape.page.mouse.move(aim.x + aim.width * 0.86, aim.y + aim.height * 0.5, { steps: 4 });
await landscape.page.waitForTimeout(160);
const aimState = await landscape.page.evaluate(() => ({
  vector: document.documentElement.dataset.vaultTouchVector,
  gyro: document.documentElement.dataset.vaultGyroProjectile,
}));
await landscape.page.screenshot({ path: "vault-responsive-landscape-current.png" });
await landscape.page.mouse.up();
const landscapeReceipt = await landscape.page.evaluate(() => ({
  viewport: [innerWidth, innerHeight],
  release: document.documentElement.dataset.vaultTouchVector,
  body: [document.body.scrollWidth, document.body.clientWidth],
  controls: document.documentElement.dataset.vaultTouchControls,
}));
await landscape.context.close();

await browser.close();
console.log(JSON.stringify({
  portrait: { ...portraitReceipt, errors: portrait.errors },
  landscape: { ...landscapeReceipt, moveState, aimState, errors: landscape.errors },
}, null, 2));

