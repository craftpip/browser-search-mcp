import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import puppeteer from "puppeteer-core";
import { loadConfig, findLightpandaPath } from "./config.js";

const LOCK_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
const CLONE_EXCLUDE_NAMES = new Set([
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "lockfile",
  "DevToolsActivePort"
]);
const CLONE_EXCLUDE_DIRS = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "Crashpad"
]);
const MONITOR_WIDTH = 1920;
const MONITOR_HEIGHT = 1080;
const ENGINE_STARTUP_URLS = {
  bing: "https://www.bing.com/",
  duckduckgo: "https://duckduckgo.com/",
  duckduckgo_chromium: "https://duckduckgo.com/",
  google: "https://www.google.com/",
  mojeek: "https://www.mojeek.com/"
};

function logBrowserEvent(label, payload) {
  const timestamp = new Date().toISOString();
  if (!payload || typeof payload !== "object") {
    const suffix = payload === undefined ? "" : ` ${String(payload)}`;
    console.error(`[${timestamp}] ${label}${suffix}`);
    return;
  }

  const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
  if (!entries.length) {
    console.error(`[${timestamp}] ${label}`);
    return;
  }

  const rendered = entries.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  console.error(`[${timestamp}] ${label} ${rendered.join(" ")}`);
}

function isLockError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("singleton") ||
    message.includes("already in use") ||
    message.includes("profile") ||
    message.includes("processsingleton") ||
    message.includes("lock")
  );
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removeIfExists(targetPath) {
  if (await fileExists(targetPath)) {
    await fs.rm(targetPath, { force: true, recursive: true });
  }
}

export class BrowserManager {
  constructor(config) {
    this.config = config;

    // Chromium
    this.browser = null;
    this.launching = null;
    this.tempProfileDir = null;
    this.keepAlivePage = null;
    this.prelaunchPromise = null;

    // Lightpanda
    this.lightpandaProcess = null;
    this.lightpandaBrowser = null;
    this.lightpandaLaunching = null;

    // Shared
    this.engineWorkingWindows = new Map();
    this.pageSlotsInUse = 0;
    this.pageSlotWaiters = [];
  }

  async ensureKeepAlivePage(browser) {
    const activeBrowser = browser || (await this.getBrowser());

    if (this.keepAlivePage && !this.keepAlivePage.isClosed()) {
      return this.keepAlivePage;
    }

    const pages = await activeBrowser.pages();
    const existing = pages.find((item) => !item.isClosed());
    if (existing) {
      this.keepAlivePage = existing;
      return existing;
    }

    const page = await this.createWindowPage(activeBrowser);
    await page.goto(this.config.startupUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.config.browserOpTimeoutMs
    });
    this.keepAlivePage = page;
    return page;
  }

  async acquirePageSlot() {
    if (this.pageSlotsInUse < this.config.maxConcurrentPageOps) {
      this.pageSlotsInUse += 1;
      return;
    }

    await new Promise((resolve) => {
      this.pageSlotWaiters.push(resolve);
    });
    this.pageSlotsInUse += 1;
  }

  releasePageSlot() {
    if (this.pageSlotsInUse > 0) {
      this.pageSlotsInUse -= 1;
    }

    const next = this.pageSlotWaiters.shift();
    if (next) {
      next();
    }
  }

  async withPageSlot(task) {
    await this.acquirePageSlot();
    try {
      return await task();
    } finally {
      this.releasePageSlot();
    }
  }

  getEnginePool(engine) {
    const key = String(engine || "").trim().toLowerCase() || "default";
    let pool = this.engineWorkingWindows.get(key);
    if (!pool) {
      pool = { engine: key, windows: [], waiters: [] };
      this.engineWorkingWindows.set(key, pool);
    }
    return pool;
  }

  buildWindowStats(engine) {
    const scoped = engine ? this.getEnginePool(engine) : null;
    if (scoped) {
      this.pruneClosedWindows(scoped);
    }

    const byEngine = {};
    let totalOpen = 0;
    let totalInUse = 0;
    let totalPending = 0;
    let totalWaiters = 0;

    for (const [name, pool] of this.engineWorkingWindows.entries()) {
      this.pruneClosedWindows(pool);
      const open = pool.windows.length;
      const inUse = pool.windows.filter((entry) => entry.inUse).length;
      const pending = pool.windows.filter((entry) => entry.pending).length;
      const waiters = pool.waiters.length;
      byEngine[name] = { open, inUse, pending, waiters };
      totalOpen += open;
      totalInUse += inUse;
      totalPending += pending;
      totalWaiters += waiters;
    }

    return {
      totalOpen,
      totalInUse,
      totalPending,
      totalWaiters,
      byEngine,
      pageSlots: {
        inUse: this.pageSlotsInUse,
        queued: this.pageSlotWaiters.length,
        max: this.config.maxConcurrentPageOps
      }
    };
  }

  logWindowEvent(label, engine, extra = {}) {
    logBrowserEvent(label, {
      engine,
      ...extra,
      stats: this.buildWindowStats()
    });
  }

  pruneClosedWindows(pool) {
    pool.windows = pool.windows.filter(
      (entry) => entry?.pending || (entry?.page && !entry.page.isClosed())
    );
  }

  async trimIdleWindows(pool, keepCount) {
    this.pruneClosedWindows(pool);

    while (pool.windows.length > keepCount) {
      const idle = pool.windows.find((entry) => !entry.pending && !entry.inUse);
      if (!idle) break;

      pool.windows = pool.windows.filter((entry) => entry !== idle);
      try {
        if (idle.page && !idle.page.isClosed()) {
          await idle.page.close();
          this.logWindowEvent("search.window.closed", pool.engine, { reason: "trim_idle", persistent: Boolean(idle.persistent) });
        }
      } catch {
        // ignore window close errors
      }
    }
  }

  async ensureProfileBase() {
    await fs.mkdir(this.config.chromeUserDataDir, { recursive: true });
  }

  async clearKnownLockFiles(userDataDir) {
    const profileDirPath = path.join(userDataDir, this.config.chromeProfileDir);
    for (const lockFile of LOCK_FILES) {
      await removeIfExists(path.join(userDataDir, lockFile));
      await removeIfExists(path.join(profileDirPath, lockFile));
    }
  }

  async cloneProfileDir(sourceDir) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-profile-clone-"));
    await fs.cp(sourceDir, tempDir, {
      recursive: true,
      force: true,
      filter: (src) => {
        const base = path.basename(src);
        if (CLONE_EXCLUDE_NAMES.has(base)) return false;
        if (CLONE_EXCLUDE_DIRS.has(base)) return false;
        return true;
      }
    });

    if (this.config.chromeProfileDir !== "Default") {
      const sourceProfilePath = path.join(tempDir, this.config.chromeProfileDir);
      const defaultProfilePath = path.join(tempDir, "Default");
      if (await fileExists(sourceProfilePath)) {
        await fs.rm(defaultProfilePath, { recursive: true, force: true });
        await fs.cp(sourceProfilePath, defaultProfilePath, { recursive: true, force: true });
      }
    }

    return tempDir;
  }

  buildLaunchArgs(profileDir) {
    return [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${MONITOR_WIDTH},${MONITOR_HEIGHT}`,
      `--profile-directory=${profileDir}`
    ];
  }

  async launchBrowser(userDataDir, profileDir = this.config.chromeProfileDir) {
    const browser = await puppeteer.launch({
      executablePath: this.config.chromePath,
      headless: this.config.headless,
      userDataDir,
      args: this.buildLaunchArgs(profileDir),
      defaultViewport: {
        width: MONITOR_WIDTH,
        height: MONITOR_HEIGHT,
        deviceScaleFactor: 1
      },
      timeout: this.config.browserOpTimeoutMs
    });

    try {
      await this.ensureKeepAlivePage(browser);
    } catch {
      // ignore initial page setup errors
    }

    browser.on("disconnected", () => {
      this.browser = null;
      if (this.config.defaultBackend === "chromium") {
        this.engineWorkingWindows.clear();
        this.keepAlivePage = null;
        this.prelaunchPromise = null;
      }
    });

    return browser;
  }

  async launchWithRecovery() {
    await this.ensureProfileBase();

    try {
      return await this.launchBrowser(this.config.chromeUserDataDir);
    } catch (firstError) {
      if (!isLockError(firstError)) throw firstError;

      await this.clearKnownLockFiles(this.config.chromeUserDataDir);

      try {
        return await this.launchBrowser(this.config.chromeUserDataDir);
      } catch (secondError) {
        if (!isLockError(secondError)) throw secondError;

        const clonedDir = await this.cloneProfileDir(this.config.chromeUserDataDir);
        this.tempProfileDir = clonedDir;
        return this.launchBrowser(clonedDir, "Default");
      }
    }
  }

  async getBrowser() {
    if (this.browser && this.browser.connected) return this.browser;
    if (this.launching) return this.launching;

    this.launching = this.launchWithRecovery();

    try {
      this.browser = await this.launching;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  async createWindowPage(browser) {
    let lastError;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let session = null;

      try {
        const pages = await browser.pages();
        const openerPage =
          (this.keepAlivePage && !this.keepAlivePage.isClosed() && this.keepAlivePage) ||
          pages.find((page) => !page.isClosed()) ||
          null;
        const openerTarget = openerPage ? openerPage.target() : browser.target();
        session = await openerTarget.createCDPSession();
        const created = await session.send("Target.createTarget", {
          url: "about:blank",
          newWindow: true
        });
        const expectedTargetId = String(created?.targetId || "");
        if (!expectedTargetId) {
          throw new Error("Browser target is not found");
        }

        const deadline = Date.now() + Math.min(this.config.browserOpTimeoutMs, 20000);
        while (Date.now() < deadline) {
          const targets = browser.targets().filter((candidate) => candidate.type() === "page");
          for (const target of targets) {
            const targetId = String(target?._targetId || target?._targetInfo?.targetId || "");
            if (targetId !== expectedTargetId) continue;

            const page = await target.page();
            if (page && !page.isClosed()) {
              return page;
            }
          }

          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        throw new Error("Browser target is not found");
      } catch (error) {
        lastError = error;
      } finally {
        if (session) {
          try {
            await session.detach();
          } catch {
            // ignore session detach errors
          }
        }
      }
    }

    throw lastError || new Error("Browser target is not found");
  }

  // ---- Lightpanda backend ----

  async _spawnLightpanda() {
    const binaryPath = this.config.lightpandaPath || (await findLightpandaPath());
    if (!binaryPath) return null;

    const port = this.config.lightpandaPort;

    return new Promise((resolve, reject) => {
      const proc = spawn(binaryPath, ["serve", "--port", String(port)], {
        stdio: ["ignore", "pipe", "pipe"]
      });

      let started = false;

      proc.on("error", (err) => {
        if (!started) reject(err);
      });

      proc.stderr.on("data", () => {
        if (!started) {
          started = true;
          resolve(proc);
        }
      });

      const poll = () => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          res.resume();
          if (!started) {
            started = true;
            resolve(proc);
          }
        });
        req.on("error", () => {
          if (!started) setTimeout(poll, 100);
        });
        req.end();
      };
      setTimeout(poll, 300);

      setTimeout(() => {
        if (!started) {
          reject(new Error("Lightpanda failed to start within 15s"));
        }
      }, 15000);
    });
  }

  async getLightpandaBrowser() {
    if (this.lightpandaBrowser?.connected) return this.lightpandaBrowser;
    if (this.lightpandaLaunching) return this.lightpandaLaunching;

    this.lightpandaLaunching = this._connectLightpanda();
    try {
      this.lightpandaBrowser = await this.lightpandaLaunching;
      return this.lightpandaBrowser;
    } finally {
      this.lightpandaLaunching = null;
    }
  }

  async _connectLightpanda() {
    let processHandle;
    try {
      processHandle = await this._spawnLightpanda();
    } catch (error) {
      logBrowserEvent("lightpanda.spawn_failed", { error: String(error?.message || error) });
      return null;
    }

    if (!processHandle) return null;

    this.lightpandaProcess = processHandle;
    processHandle.on("exit", (code) => {
      logBrowserEvent("lightpanda.exit", { code });
      this.lightpandaProcess = null;
      this.lightpandaBrowser = null;
    });

    const browser = await puppeteer.connect({
      browserWSEndpoint: `ws://127.0.0.1:${this.config.lightpandaPort}`,
      defaultViewport: { width: MONITOR_WIDTH, height: MONITOR_HEIGHT }
    });

    this.lightpandaBrowser = browser;
    browser.on("disconnected", () => {
      this.lightpandaBrowser = null;
    });

    return browser;
  }

  async _newLightpandaPage() {
    const browser = await this.getLightpandaBrowser();
    if (!browser) {
      return this._newChromiumPage();
    }

    const page = await browser.newPage();
    await page.setUserAgent(this.config.userAgent);
    page.setDefaultNavigationTimeout(this.config.browserOpTimeoutMs);
    page.setDefaultTimeout(this.config.browserOpTimeoutMs);

    // Inject stealth patches to avoid bot detection.
    // These run before any page scripts on every navigation.
    await page.evaluateOnNewDocument(() => {
      // Override navigator.webdriver
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
        configurable: true,
      });

      // Spoof navigator.plugins
      const makePlugin = (name, filename, description) => {
        const plugin = {
          name,
          filename,
          description,
          length: 0,
          item: () => null,
          namedItem: () => null,
          [Symbol.iterator]: function* () {},
        };
        return plugin;
      };
      const plugins = [
        makePlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format'),
        makePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''),
        makePlugin('Native Client', 'internal-nacl-plugin', ''),
      ];
      const pluginArray = Object.assign(plugins.slice(), {
        item: (i) => plugins[i] || null,
        namedItem: (n) => plugins.find((p) => p.name === n) || null,
        refresh: () => {},
        length: plugins.length,
        [Symbol.iterator]: function* () { yield* plugins; },
      });
      Object.defineProperty(navigator, 'plugins', {
        get: () => pluginArray,
        configurable: true,
      });

      // Spoof navigator.mimeTypes
      const mimeTypes = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ];
      const mimeTypeArray = Object.assign(mimeTypes.slice(), {
        item: (i) => mimeTypes[i] || null,
        namedItem: (n) => mimeTypes.find((m) => m.type === n) || null,
        length: mimeTypes.length,
        [Symbol.iterator]: function* () { yield* mimeTypes; },
      });
      Object.defineProperty(navigator, 'mimeTypes', {
        get: () => mimeTypeArray,
        configurable: true,
      });

      // Spoof navigator.languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
        configurable: true,
      });

      // Spoof navigator.platform
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Linux x86_64',
        configurable: true,
      });

      // Spoof navigator.hardwareConcurrency
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
        configurable: true,
      });

      // Spoof navigator.deviceMemory
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
        configurable: true,
      });

      // Add window.chrome object
      if (!window.chrome) {
        window.chrome = {
          runtime: {},
          loadTimes: () => null,
          csi: () => null,
          app: {},
        };
      }

      // Override navigator.connection to include effectiveType
      if (navigator.connection) {
        Object.defineProperty(navigator.connection, 'effectiveType', {
          get: () => '4g',
          configurable: true,
        });
      }

      // Remove webdriver from navigator
      if (navigator.hasOwnProperty('webdriver')) {
        delete navigator.webdriver;
      }

      // Hide headless chrome by overriding permissions
      const origQuery = navigator.permissions?.query;
      if (origQuery) {
        navigator.permissions.query = (params) => {
          if (params?.name === 'notifications') {
            return Promise.resolve({ state: 'denied', onchange: null });
          }
          return origQuery(params);
        };
      }
    });

    return page;
  }

  async _newChromiumPage() {
    const browser = await this.getBrowser();
    await this.ensureKeepAlivePage(browser);
    const page = await this.createWindowPage(browser);

    await page.setUserAgent(this.config.userAgent);
    page.setDefaultNavigationTimeout(this.config.browserOpTimeoutMs);
    page.setDefaultTimeout(this.config.browserOpTimeoutMs);
    return page;
  }

  async newPage(options = {}) {
    const engine = (options && options.engine) || "";
    const backend = (options && options.backend) || this.config.defaultBackend;
    // Chromium-only routes handle JS-heavy/CAPTCHA-prone engines.
    const needsChromium = ["duckduckgo_chromium", "google"].includes(engine.toLowerCase());
    if (needsChromium) {
      return this._newChromiumPage();
    }
    return backend === "chromium" ? this._newChromiumPage() : this._newLightpandaPage();
  }

  _poolEngine(engine) {
    // Chromium routes use per-engine pools; Lightpanda routes share one pool.
    if (["duckduckgo_chromium", "google"].includes((engine || "").toLowerCase())) return engine;
    return this.config.defaultBackend !== "chromium" ? "_shared" : engine;
  }

  _poolMaxWindows(poolEngine) {
    if (poolEngine === "_shared" && this.config.defaultBackend !== "chromium") return 1;
    return this.config.searchMaxWorkingWindows;
  }

  async ensureMinWorkingWindows(engine, { startupUrl, waitUntil = "domcontentloaded" } = {}) {
    const needsChromium = ["duckduckgo_chromium", "google"].includes((engine || "").toLowerCase());
    if (this.config.defaultBackend !== "chromium" && !needsChromium) return;
    const pool = this.getEnginePool(engine);
    this.pruneClosedWindows(pool);

    const minWindows = this.config.searchKeepMinWorkingWindows;
    const maxWindows = this._poolMaxWindows(engine);
    const target = Math.min(minWindows, maxWindows);
    const missing = Math.max(0, target - pool.windows.length);

    for (let index = 0; index < missing; index += 1) {
      const entry = {
        page: null,
        inUse: false,
        persistent: true,
        pending: true,
        engine: String(engine || "").trim().toLowerCase() || "default"
      };
      pool.windows.push(entry);

      try {
        const page = await this.newPage({ engine });
        entry.page = page;
        entry.pending = false;

        page.on("close", () => {
          const activePool = this.getEnginePool(entry.engine);
          activePool.windows = activePool.windows.filter((item) => item.page !== page);
        });

        if (startupUrl) {
          await page.goto(startupUrl, {
            waitUntil,
            timeout: this.config.browserOpTimeoutMs
          });
        }
        this.logWindowEvent("search.window.opened", entry.engine, { reason: "warmup", persistent: true });
      } catch (error) {
        pool.windows = pool.windows.filter((item) => item !== entry);
        throw error;
      }
    }
  }

  async acquireSearchWindow(engine, { startupUrl, waitUntil = "domcontentloaded" } = {}) {
    if (this.prelaunchPromise) {
      await this.prelaunchPromise.catch(() => {
        // ignore prelaunch errors; search path will attempt normal creation
      });
    }

    const poolEngine = this._poolEngine(engine);
    await this.ensureMinWorkingWindows(poolEngine, { startupUrl, waitUntil });
    const pool = this.getEnginePool(poolEngine);

    while (true) {
      this.pruneClosedWindows(pool);
      const idle = pool.windows.find((entry) => !entry.pending && !entry.inUse);
      if (idle) {
        idle.inUse = true;
        return idle.page;
      }

      if (pool.windows.length < this._poolMaxWindows(poolEngine)) {
        const entry = {
          page: null,
          inUse: true,
          persistent: false,
          pending: true,
          engine: poolEngine
        };
        pool.windows.push(entry);
        try {
          const page = await this.newPage({ engine: poolEngine });
          entry.page = page;
          entry.pending = false;

          page.on("close", () => {
            const activePool = this.getEnginePool(entry.engine);
            activePool.windows = activePool.windows.filter((item) => item.page !== page);
          });

          if (startupUrl) {
            await page.goto(startupUrl, {
              waitUntil,
              timeout: this.config.browserOpTimeoutMs
            });
          }
          this.logWindowEvent("search.window.opened", entry.engine, { reason: "on_demand", persistent: false });
          return page;
        } catch (error) {
          pool.windows = pool.windows.filter((item) => item !== entry);
          throw error;
        }
      }

      await new Promise((resolve) => {
        pool.waiters.push(resolve);
      });
    }
  }

  async releaseSearchWindow(engine, page) {
    const poolEngine = this._poolEngine(engine);
    const pool = this.getEnginePool(poolEngine);
    this.pruneClosedWindows(pool);
    const entry = pool.windows.find((item) => item.page === page);
    if (!entry) return;

    if (entry.pending || !entry.page || entry.page.isClosed()) {
      pool.windows = pool.windows.filter((item) => item !== entry);
    } else if (!entry.persistent && pool.windows.length > Math.max(this.config.searchKeepMinWorkingWindows, 1)) {
      pool.windows = pool.windows.filter((item) => item !== entry);
      try {
        await entry.page.close();
        this.logWindowEvent("search.window.closed", entry.engine, { reason: "release_over_min", persistent: false });
      } catch {
        // ignore window close errors
      }
    } else {
      entry.inUse = false;
      if (pool.windows.filter((item) => item.persistent).length < this.config.searchKeepMinWorkingWindows) {
        entry.persistent = true;
      }
    }

    if (!pool.waiters.length) {
      await this.trimIdleWindows(pool, Math.max(this.config.searchKeepMinWorkingWindows, 1));
    }

    const next = pool.waiters.shift();
    if (next) {
      next();
    }
  }

  async getHealth() {
    const pools = {};
    let totalSearchWindows = 0;

    for (const [engine, pool] of this.engineWorkingWindows.entries()) {
      this.pruneClosedWindows(pool);
      const total = pool.windows.length;
      const inUse = pool.windows.filter((entry) => entry.inUse).length;
      const pending = pool.windows.filter((entry) => entry.pending).length;
      const persistent = pool.windows.filter((entry) => entry.persistent).length;
      totalSearchWindows += total;
      pools[engine] = { total, inUse, pending, persistent };
    }

    return {
      ok: true,
      backend: this.config.defaultBackend,
      browserConnected: Boolean(this.browser?.connected),
      lightpandaConnected: Boolean(this.lightpandaBrowser?.connected),
      headless: this.config.headless,
      userDataDir: this.config.chromeUserDataDir,
      profileDir: this.config.chromeProfileDir,
      searchEngines: this.config.searchEngines,
      searchWindows: {
        total: totalSearchWindows,
        byEngine: pools
      },
      pageLimiter: {
        maxConcurrentPageOps: this.config.maxConcurrentPageOps,
        inUse: this.pageSlotsInUse,
        queued: this.pageSlotWaiters.length
      }
    };
  }

  async prelaunchIfConfigured() {
    if (!this.config.prelaunchBrowser) return;

    // Always pre-launch Chromium so screenshots are fast
    this._prelaunchChromium().catch(() => {});

    if (this.config.defaultBackend !== "chromium") return;
    if (this.prelaunchPromise) {
      return this.prelaunchPromise;
    }

    this.prelaunchPromise = (async () => {
      const browser = await this.getBrowser();
      const pages = await browser.pages();
      if (pages.length > 0) {
        await pages[0].goto(this.config.startupUrl, {
          waitUntil: "domcontentloaded",
          timeout: this.config.browserOpTimeoutMs
        });
      } else {
        const page = await this.newPage();
        await page.goto(this.config.startupUrl, {
          waitUntil: "domcontentloaded",
          timeout: this.config.browserOpTimeoutMs
        });
      }

      await Promise.allSettled(
        this.config.searchEngines.map((engine) =>
          this.ensureMinWorkingWindows(engine, {
            startupUrl: ENGINE_STARTUP_URLS[engine] || "about:blank",
            waitUntil: "domcontentloaded"
          })
        )
      );

      logBrowserEvent("search.warmup.ready", {
        engines: this.config.searchEngines,
        minWindowsPerEngine: this.config.searchKeepMinWorkingWindows,
        maxWindowsPerEngine: this.config.searchMaxWorkingWindows,
        stats: this.buildWindowStats()
      });
    })();

    return this.prelaunchPromise;
  }

  async _prelaunchChromium() {
    const browser = await this.getBrowser();
    await this.ensureKeepAlivePage(browser);
    logBrowserEvent("chromium.prelaunch.ready", { reason: "screenshot_backend" });
  }

  async shutdown() {
    // Chromium shutdown
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // ignore close errors on shutdown
      }
      this.browser = null;
    }

    if (this.tempProfileDir) {
      try {
        await fs.rm(this.tempProfileDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup errors
      }
      this.tempProfileDir = null;
    }

    // Lightpanda shutdown
    if (this.lightpandaBrowser) {
      try {
        await this.lightpandaBrowser.close();
      } catch {
        // ignore close errors on shutdown
      }
      this.lightpandaBrowser = null;
    }

    if (this.lightpandaProcess) {
      try {
        this.lightpandaProcess.kill();
      } catch {
        // ignore process kill errors
      }
      this.lightpandaProcess = null;
    }

    this.engineWorkingWindows.clear();
    this.keepAlivePage = null;
    this.prelaunchPromise = null;
  }
}

let managerPromise;

export async function getBrowserManager() {
  if (!managerPromise) {
    managerPromise = loadConfig().then((config) => new BrowserManager(config));
  }
  return managerPromise;
}
