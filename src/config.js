import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WAIT_UNTIL_VALUES = new Set([
  "load",
  "domcontentloaded",
  "networkidle0",
  "networkidle2"
]);

const SEARCH_ENGINE_VALUES = new Set([
  "bing_cb", "bing_lp",
  "duckduckgo_api", "duckduckgo_cb", "duckduckgo_ch",
  "google_cb", "google_ch", "google_lp",
  "mojeek_lp"
]);

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseEngines(value, fallback) {
  if (!value || typeof value !== "string") return fallback;
  const parsed = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .filter((item) => SEARCH_ENGINE_VALUES.has(item));
  return parsed.length ? [...new Set(parsed)] : fallback;
}

async function canAccess(path) {
  try {
    await fs.access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutableInPath(command) {
  try {
    const { stdout } = await execFileAsync("which", [command]);
    const resolved = stdout.trim();
    if (!resolved) return null;
    return (await canAccess(resolved)) ? resolved : null;
  } catch {
    return null;
  }
}

export async function resolveChromePath() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && (await canAccess(fromEnv))) {
    return fromEnv;
  }

  const knownPaths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];

  for (const candidate of knownPaths) {
    if (await canAccess(candidate)) {
      return candidate;
    }
  }

  const pathCandidates = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
  for (const candidate of pathCandidates) {
    const resolved = await findExecutableInPath(candidate);
    if (resolved) return resolved;
  }

  throw new Error(
    "Could not resolve Chromium executable. Set CHROME_PATH to a valid browser binary."
  );
}

export async function findCloakbrowserPath() {
  const fromEnv = process.env.CLOAKBROWSER_BINARY_PATH;
  if (fromEnv && (await canAccess(fromEnv))) {
    return fromEnv;
  }

  const homeDir = os.homedir?.() || process.env.HOME || "/root";
  const knownPaths = [
    `${homeDir}/.cloakbrowser/chromium-146.0.7680.177.5/chrome`,
    `${homeDir}/.cloakbrowser/chromium-*/chrome`,
    "/usr/local/bin/cloakbrowser-chrome"
  ];

  for (const candidate of knownPaths) {
    if (candidate.includes("*")) {
      const parts = candidate.split("*");
      const prefix = parts[0];
      try {
        const entries = await fs.readdir(path.dirname(prefix));
        const matching = entries
          .filter((entry) => entry.startsWith(path.basename(prefix)))
          .sort()
          .reverse();
        for (const match of matching) {
          const fullPath = path.join(path.dirname(prefix), match, "chrome");
          if (await canAccess(fullPath)) return fullPath;
        }
      } catch {
        continue;
      }
    } else if (await canAccess(candidate)) {
      return candidate;
    }
  }

  try {
    const { launch } = await import("cloakbrowser/puppeteer");
    const { ensureBinary } = await import("cloakbrowser/dist/download.js");
    const binaryPath = await ensureBinary();
    return binaryPath;
  } catch {
    return null;
  }
}

export async function findLightpandaPath() {
  const fromEnv = process.env.LIGHTPANDA_PATH;
  if (fromEnv && (await canAccess(fromEnv))) {
    return fromEnv;
  }

  const knownPaths = [
    "/usr/local/bin/lightpanda",
    "/usr/bin/lightpanda"
  ];

  for (const candidate of knownPaths) {
    if (await canAccess(candidate)) {
      return candidate;
    }
  }

  const pathCandidates = ["lightpanda", "stealthpanda"];
  for (const candidate of pathCandidates) {
    const resolved = await findExecutableInPath(candidate);
    if (resolved) return resolved;
  }

  return null;
}

const headlessDefault = !process.env.DISPLAY;

export async function loadConfig() {
  const navWaitUntilRaw = process.env.NAV_WAIT_UNTIL || "domcontentloaded";
  const navWaitUntil = WAIT_UNTIL_VALUES.has(navWaitUntilRaw)
    ? navWaitUntilRaw
    : "networkidle2";

  const screenshotPathPrefix = process.env.ENABLE_SCREENSHOT_PATH || "";
  const searchKeepMinWorkingWindowsRaw = Number(process.env.SEARCH_KEEP_MIN_WORKING_WINDOWS ?? 2);
  const searchKeepMinWorkingWindows = Number.isFinite(searchKeepMinWorkingWindowsRaw)
    ? Math.max(0, Math.min(20, Math.floor(searchKeepMinWorkingWindowsRaw)))
    : 2;
  const searchMaxWorkingWindowsRaw = parseInteger(process.env.SEARCH_MAX_WORKING_WINDOWS, 10);
  const searchMaxWorkingWindows = Math.max(
    searchKeepMinWorkingWindows,
    Math.max(1, Math.min(30, searchMaxWorkingWindowsRaw))
  );

  const chromePath = await resolveChromePath();
  const lightpandaPath = await findLightpandaPath();
  const cloakbrowserPath = await findCloakbrowserPath();

  return {
    chromePath,
    chromeUserDataDir: process.env.CHROME_USER_DATA_DIR || "/data/chrome",
    chromeProfileDir: process.env.CHROME_PROFILE_DIR || "Default",
    lightpandaPath,
    lightpandaPort: parseNumber(process.env.LIGHTPANDA_PORT, 9222),
    cloakbrowserPath,
    defaultBackend: (() => {
      const raw = (process.env.BROWSER_BACKEND || "cloakbrowser").toLowerCase();
      if (raw === "chromium") return "chromium";
      if (raw === "cloakbrowser") return "cloakbrowser";
      return "lightpanda";
    })(),
    browserOpTimeoutMs: parseNumber(process.env.BROWSER_OP_TIMEOUT_MS, 60000),
    navWaitUntil,
    headless: parseBoolean(process.env.HEADLESS, headlessDefault),
    userAgent:
      process.env.BROWSER_USER_AGENT ||
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    mcpApiPort: parseNumber(process.env.MCP_API_PORT || process.env.HEALTH_PORT, 3000),
    mcpApiHost: process.env.MCP_API_HOST || "http://localhost",
    enableHttpHealth: parseBoolean(process.env.ENABLE_HTTP_HEALTH, false),
    enableHttpMcp: parseBoolean(process.env.ENABLE_HTTP_MCP, false),
    enableStdioMcp: parseBoolean(process.env.ENABLE_STDIO_MCP, true),
    enableScreenshotDownloadLink: parseBoolean(process.env.ENABLE_SCREENSHOT_DOWNLOAD_LINK, false),
    screenshotPathPrefix: screenshotPathPrefix.trim() || null,
    searchKeepMinWorkingWindows,
    searchMaxWorkingWindows,
    searchRouteCircuitOpenMs: parseNumber(process.env.SEARCH_ROUTE_CIRCUIT_OPEN_MS, 300000),
    openPageMaxParallel: Math.max(1, Math.min(20, parseInteger(process.env.OPEN_PAGE_MAX_PARALLEL, 6))),
    maxConcurrentPageOps: Math.max(1, Math.min(30, parseInteger(process.env.MAX_CONCURRENT_PAGE_OPS, 30))),
    humanTypingDelay: Math.max(0, Math.min(500, parseInteger(process.env.HUMAN_TYPING_DELAY, 15))),
    prelaunchBrowser: parseBoolean(process.env.PRELAUNCH_BROWSER, true),
    enableHangRestart: parseBoolean(process.env.ENABLE_HANG_RESTART, false),
    hangRestartTimeoutMs: parseNumber(process.env.HANG_RESTART_TIMEOUT_MS, 120000),
    startupUrl: process.env.STARTUP_URL || "about:blank",
    searchRouteWarmupEngines: parseEngines(process.env.SEARCH_ROUTE_WARMUP_ENGINES, ["duckduckgo_api", "google_cb", "google_lp", "bing_lp", "duckduckgo_cb", "bing_cb"]),
    searchFallback: process.env.SEARCH_FALLBACK
      ? parseEngines(process.env.SEARCH_FALLBACK, [])
      : null
  };
}
