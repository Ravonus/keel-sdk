const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const zlib = require("node:zlib");
const { chromium } = require("../apps/studio/node_modules/@playwright/test");

const repoRoot = path.resolve(__dirname, "..");
const viewerPath = path.join(
  repoRoot,
  "examples/demos/vault-arcade/generated-attribute-proxy/vault-keel-viewer-bundled.html",
);
const runCount = integerArgument("--runs", 20, 10, 50);
const sampleFrames = integerArgument("--frames", 180, 60, 900);
const browserBatchSize = integerArgument("--browser-batch", 5, 1, 10);
const enforce = process.argv.includes("--enforce");
const outPath = valueAfter("--out");
const viewerBytes = fs.readFileSync(viewerPath);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerArgument(flag, fallback, minimum, maximum) {
  const parsed = Number.parseInt(valueAfter(flag) ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function percentile(values, amount) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * amount) - 1))];
}

function rounded(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function metric(metrics, name) {
  return metrics.find((entry) => entry.name === name)?.value ?? 0;
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ocas": "application/octet-stream",
};

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
  const target = path.resolve(repoRoot, relative || path.relative(repoRoot, viewerPath));
  if (target !== repoRoot && !target.startsWith(`${repoRoot}${path.sep}`)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(target, (error, bytes) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end(error.code ?? "read-error");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": mime[path.extname(target)] ?? "application/octet-stream",
    });
    response.end(bytes);
  });
});

async function frameSample(page, count) {
  return page.evaluate((frameCount) => new Promise((resolve) => {
    const samples = [];
    let previous;
    const sample = (time) => {
      if (previous !== undefined) samples.push(time - previous);
      previous = time;
      if (samples.length >= frameCount) resolve(samples);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }), count);
}

async function runOnce(browser, baseUrl, index) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const consoleProblems = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) consoleProblems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    globalThis.__VAULT_BENCHMARK_NAVIGATION_START__ = performance.now();
    globalThis.__VAULT_BENCHMARK_LONG_TASKS__ = [];
    if (typeof PerformanceObserver === "function") {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) globalThis.__VAULT_BENCHMARK_LONG_TASKS__.push(entry.duration);
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch {}
    }
  });
  const seedByte = ((index * 37 + 17) % 255).toString(16).padStart(2, "0");
  const attributeByte = ((index * 53 + 29) % 255).toString(16).padStart(2, "0");
  const url = `${baseUrl}?chainId=11155111&tokenId=${index + 1}&seed=0x${seedByte.repeat(32)}&attributes=0x${attributeByte.repeat(32)}`;
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  if (!response?.ok()) throw new Error(`Vault viewer returned HTTP ${response?.status() ?? "no response"}.`);
  await page.waitForFunction(() => document.documentElement.dataset.vaultCharacterReady === "true", null, { timeout: 20_000 });
  const ready = await page.evaluate(() => ({
    observedMilliseconds: performance.now() - globalThis.__VAULT_BENCHMARK_NAVIGATION_START__,
    verification: document.documentElement.dataset.vaultVerification,
    bodyClass: document.body.className,
    title: document.querySelector("#verify-title")?.textContent ?? "",
    milestones: Object.fromEntries(performance.getEntriesByType("mark")
      .filter((entry) => entry.name.startsWith("vault:"))
      .map((entry) => [entry.name.slice("vault:".length), entry.startTime - globalThis.__VAULT_BENCHMARK_NAVIGATION_START__])),
    navigation: (() => {
      const entry = performance.getEntriesByType("navigation")[0];
      return entry === undefined ? {} : {
        responseEnd: entry.responseEnd,
        domInteractive: entry.domInteractive,
        domContentLoaded: entry.domContentLoadedEventEnd,
      };
    })(),
  }));
  ready.milliseconds = ready.milestones["first-frame-ready"];
  await page.waitForTimeout(350);

  const idleFrames = await frameSample(page, sampleFrames);
  const beforeInput = await page.evaluate(() => globalThis.__VAULT_CHARACTER_ARENA__.snapshot());
  await page.locator("#vault-character").click({ position: { x: 500, y: 360 } });
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(180);
  await page.keyboard.up("KeyD");
  await page.keyboard.press("KeyF");
  await page.keyboard.press("Space");
  await page.keyboard.press("KeyE");
  await page.keyboard.press("KeyQ");
  await page.waitForTimeout(180);
  const afterInput = await page.evaluate(() => globalThis.__VAULT_CHARACTER_ARENA__.snapshot());

  await page.evaluate(() => {
    const arena = globalThis.__VAULT_CHARACTER_ARENA__;
    for (let index = 0; index < 48; index += 1) {
      const angle = index / 48 * Math.PI * 2;
      arena.spawnMob({
        archetype: index % 4 === 0 ? "charger" : "drifter",
        elite: index % 11 === 0,
        variant: index,
        x: Math.cos(angle) * (240 + index * 8),
        y: Math.sin(angle) * (240 + index * 8),
      });
    }
    arena.stressParticles(4096);
    for (let index = 0; index < 64; index += 1) arena.fire();
  });
  const stressFrames = await frameSample(page, sampleFrames);
  const snapshot = await page.evaluate(() => globalThis.__VAULT_CHARACTER_ARENA__.snapshot());
  const pageState = await page.evaluate(() => ({
    canvas: {
      width: document.querySelector("#vault-character")?.width ?? 0,
      height: document.querySelector("#vault-character")?.height ?? 0,
    },
    longTasks: globalThis.__VAULT_BENCHMARK_LONG_TASKS__ ?? [],
    runtimeErrors: Number(document.documentElement.dataset.vaultRuntimeErrors ?? 0),
    weaponFramesReady: Number(document.documentElement.dataset.vaultWeaponFramesReady ?? 0),
  }));
  const performanceMetrics = (await cdp.send("Performance.getMetrics")).metrics;
  const canvasPng = await page.locator("#vault-character").screenshot({ type: "png" });
  await context.close();

  const inputDistance = Math.hypot(
    afterInput.player.x - beforeInput.player.x,
    afterInput.player.y - beforeInput.player.y,
  );
  return {
    ready,
    input: {
      movedWorldUnits: rounded(inputDistance),
      arenaActivated: afterInput.active,
      escapeTriggered: afterInput.player.x !== beforeInput.player.x || afterInput.player.y !== beforeInput.player.y,
      defendTriggered: afterInput.shield >= beforeInput.shield,
    },
    idle: summarizeFrames(idleFrames),
    stress: summarizeFrames(stressFrames),
    runtimeBudget: snapshot.runtimeBudget,
    stressState: {
      mobs: snapshot.mobs.length,
      projectiles: snapshot.projectiles,
      particles: snapshot.particles,
      damagePopups: snapshot.damagePopups,
    },
    browser: {
      jsHeapUsedBytes: Math.round(metric(performanceMetrics, "JSHeapUsedSize")),
      jsHeapTotalBytes: Math.round(metric(performanceMetrics, "JSHeapTotalSize")),
      nodes: Math.round(metric(performanceMetrics, "Nodes")),
      layouts: Math.round(metric(performanceMetrics, "LayoutCount")),
      styleRecalculations: Math.round(metric(performanceMetrics, "RecalcStyleCount")),
      taskDurationMilliseconds: rounded(metric(performanceMetrics, "TaskDuration") * 1000),
      longTaskCount: pageState.longTasks.length,
      longTaskMaximumMilliseconds: rounded(Math.max(0, ...pageState.longTasks)),
      weaponFramesReady: pageState.weaponFramesReady,
    },
    canvas: pageState.canvas,
    canvasSha256: crypto.createHash("sha256").update(canvasPng).digest("hex"),
    runtimeErrors: pageState.runtimeErrors,
    consoleProblems,
    pageErrors,
  };
}

async function auditStakeVerifier(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const problems = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await page.addInitScript(() => {
    const bytes32 = (byte) => `0x${byte.repeat(64)}`;
    globalThis.__KEEL_CONTEXT__ = Object.freeze({
      chainId: 11155111,
      tokenId: "7",
      derivedTokenSeed: bytes32("1"),
      packedAttributes: bytes32("2"),
      assetId: "0x0275a444d4957cb28141dffcce602f47de8334040f18b8283e9cd88e78def9cc",
      stakeObject: Object.freeze({
        active: true,
        managerVerified: true,
        chain: "ethereum",
        manager: "0x1111111111111111111111111111111111111111",
        stakeObjectId: bytes32("2"),
        viewerId: bytes32("3"),
        hostCollection: "0x2222222222222222222222222222222222222222",
        hostTokenId: "42",
        stakedCollection: "0x3333333333333333333333333333333333333333",
        stakedTokenId: "7",
        tokenOwner: "0x1111111111111111111111111111111111111111",
        staker: "0x4444444444444444444444444444444444444444",
        hostOwner: "0x5555555555555555555555555555555555555555",
        controller: "0x1111111111111111111111111111111111111111",
        managerPolicy: Object.freeze({ mode: "official" }),
        lockup: Object.freeze({ mode: "minimum-duration", seconds: 3600 }),
        startedAt: "2026-08-12T10:00:00Z",
        counters: Object.freeze({ objectTokenLifetime: 3, objectLifetime: 12, objectActive: 2, tokenLifetime: 5, tokenActive: 1, globalLifetime: 81, globalActive: 9 }),
        slot: 4,
        stakedEntrypoint: "vault-runner-map",
        codeObjectId: bytes32("9"),
        codeObjectRevision: 4,
        runtimeDigest: bytes32("a"),
        backpack: Object.freeze({ kind: "erc6551", account: "0x6666666666666666666666666666666666666666" }),
        managerProof: Object.freeze({ codeHash: bytes32("7"), evidenceDigest: bytes32("8") }),
      }),
    });
  });
  const response = await page.goto(`${baseUrl}?tokenId=7&seed=0x${"11".repeat(32)}&attributes=0x${"22".repeat(32)}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  if (!response?.ok()) throw new Error(`Stake verifier fixture returned HTTP ${response?.status() ?? "no response"}.`);
  await page.waitForFunction(() => document.documentElement.dataset.vaultCharacterReady === "true", null, { timeout: 20_000 });
  await page.evaluate(() => document.querySelector("#verify-seal")?.click());
  const result = await page.evaluate(() => {
    const section = document.querySelector('[data-keel-panel-type="staking"]');
    const text = section?.textContent ?? "";
    return {
      visible: section !== null,
      activeTitle: text.includes("Stake object · active"),
      ownerVisible: text.includes("0x1111111111111111111111111111111111111111"),
      stakerVisible: text.includes("0x4444444444444444444444444444444444444444"),
      lockupVisible: text.includes("3600 seconds"),
      objectCountVisible: text.includes("12"),
      objectActiveVisible: text.includes("Characters active in this map") && text.includes("2"),
      tokenCountVisible: text.includes("5"),
      globalCountVisible: text.includes("81"),
      backpackVisible: text.includes("erc6551"),
      rulesVisible: text.includes("unstake restores the original entrypoint"),
    };
  });
  await context.close();
  return { ...result, problems, pass: Object.values(result).every(Boolean) && problems.length === 0 };
}

function summarizeFrames(samples) {
  return {
    count: samples.length,
    medianMilliseconds: rounded(percentile(samples, 0.5)),
    p95Milliseconds: rounded(percentile(samples, 0.95)),
    maximumMilliseconds: rounded(Math.max(...samples)),
    framesOver20Milliseconds: samples.filter((value) => value > 20).length,
    framesOver34Milliseconds: samples.filter((value) => value > 34).length,
  };
}

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const viewerUrl = `http://127.0.0.1:${address.port}/${path.relative(repoRoot, viewerPath).split(path.sep).join("/")}`;
  const executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const launchBrowser = () => chromium.launch({
    headless: true,
    executablePath: fs.existsSync(executablePath) ? executablePath : undefined,
  });
  const runs = [];
  let stakeVerifier;
  let browser;
  try {
    for (let index = 0; index < runCount; index += 1) {
      if (index % browserBatchSize === 0) {
        await browser?.close();
        browser = await launchBrowser();
      }
      runs.push(await runOnce(browser, viewerUrl, index));
    }
    if (browser === undefined) browser = await launchBrowser();
    stakeVerifier = await auditStakeVerifier(browser, viewerUrl);
  } finally {
    await browser?.close();
    server.close();
  }

  const readyTimes = runs.map((run) => run.ready.milliseconds);
  const startupMilestoneNames = ["module-start", "verification-ready", "catalogs-ready", "visual-assets-ready", "material-atlases-ready", "api-ready", "first-frame-ready"];
  const startupMilestoneP95 = Object.fromEntries(startupMilestoneNames.map((name) => [
    name,
    rounded(percentile(runs.map((run) => run.ready.milestones[name]).filter(Number.isFinite), .95)),
  ]));
  const startupPhaseP95 = (from, to) => rounded(percentile(runs.map((run) =>
    run.ready.milestones[to] - (from === "navigation" ? 0 : run.ready.milestones[from])), .95));
  const report = {
    schema: "vault-orb-core-benchmark@2",
    generatedAt: new Date().toISOString(),
    parameters: { runs: runCount, sampleFrames, browserBatchSize },
    artifact: {
      path: path.relative(repoRoot, viewerPath),
      bytes: viewerBytes.length,
      gzipBytes: zlib.gzipSync(viewerBytes, { level: 9 }).length,
      brotliBytes: zlib.brotliCompressSync(viewerBytes).length,
      sha256: crypto.createHash("sha256").update(viewerBytes).digest("hex"),
    },
    metrics: {
      readyMilliseconds: {
        median: rounded(percentile(readyTimes, 0.5)),
        p95: rounded(percentile(readyTimes, 0.95)),
        maximum: rounded(Math.max(...readyTimes)),
      },
      startupMilestoneP95Milliseconds: startupMilestoneP95,
      startupPhaseP95Milliseconds: {
        navigationToModule: startupPhaseP95("navigation", "module-start"),
        moduleToVerification: startupPhaseP95("module-start", "verification-ready"),
        verificationToVisualAssets: startupPhaseP95("verification-ready", "visual-assets-ready"),
        visualAssetsToMaterialAtlases: startupPhaseP95("visual-assets-ready", "material-atlases-ready"),
        materialAtlasesToApi: startupPhaseP95("material-atlases-ready", "api-ready"),
        apiToFirstFrame: startupPhaseP95("api-ready", "first-frame-ready"),
      },
      idleFrameP95Milliseconds: rounded(Math.max(...runs.map((run) => run.idle.p95Milliseconds))),
      stressFrameP95Milliseconds: rounded(Math.max(...runs.map((run) => run.stress.p95Milliseconds))),
      workP95Milliseconds: rounded(Math.max(...runs.map((run) => run.runtimeBudget.workP95Ms))),
      maximumHeapBytes: Math.max(...runs.map((run) => run.browser.jsHeapUsedBytes)),
      consoleProblems: runs.reduce((sum, run) => sum + run.consoleProblems.length + run.pageErrors.length, 0),
      runtimeErrors: runs.reduce((sum, run) => sum + run.runtimeErrors, 0),
      inputPasses: runs.filter((run) => run.input.movedWorldUnits > 0 && run.input.arenaActivated).length,
      verifiedRuns: runs.filter((run) => run.ready.verification === "verified").length,
      distinctCanvasHashes: new Set(runs.map((run) => run.canvasSha256)).size,
      weaponFramePrewarmPasses: runs.filter((run) => run.browser.weaponFramesReady === 9).length,
    },
    gates: {
      readyP95MaximumMilliseconds: 250,
      idleFrameP95MaximumMilliseconds: 20,
      stressFrameP95MaximumMilliseconds: 24,
      workP95MaximumMilliseconds: 10,
      heapMaximumBytes: 96 * 1024 * 1024,
      consoleProblemsMaximum: 0,
      runtimeErrorsMaximum: 0,
      inputPassesMinimum: runCount,
      verifiedRunsMinimum: runCount,
      distinctCanvasHashesMinimum: Math.min(runCount, 4),
      weaponFramePrewarmPassesMinimum: runCount,
      stakeVerifierRequired: true,
    },
    stakeVerifier,
    runs,
  };
  report.pass = report.metrics.readyMilliseconds.p95 <= report.gates.readyP95MaximumMilliseconds
    && report.metrics.idleFrameP95Milliseconds <= report.gates.idleFrameP95MaximumMilliseconds
    && report.metrics.stressFrameP95Milliseconds <= report.gates.stressFrameP95MaximumMilliseconds
    && report.metrics.workP95Milliseconds <= report.gates.workP95MaximumMilliseconds
    && report.metrics.maximumHeapBytes <= report.gates.heapMaximumBytes
    && report.metrics.consoleProblems <= report.gates.consoleProblemsMaximum
    && report.metrics.runtimeErrors <= report.gates.runtimeErrorsMaximum
    && report.metrics.inputPasses >= report.gates.inputPassesMinimum
    && report.metrics.verifiedRuns >= report.gates.verifiedRunsMinimum
    && report.metrics.distinctCanvasHashes >= report.gates.distinctCanvasHashesMinimum
    && report.metrics.weaponFramePrewarmPasses >= report.gates.weaponFramePrewarmPassesMinimum
    && report.stakeVerifier.pass === report.gates.stakeVerifierRequired;

  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) fs.writeFileSync(path.resolve(repoRoot, outPath), output);
  process.stdout.write(output);
  if (enforce && !report.pass) process.exitCode = 1;
})().catch((error) => {
  server.close();
  console.error(error);
  process.exitCode = 1;
});
