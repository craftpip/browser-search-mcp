import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest
} from "@modelcontextprotocol/sdk/types.js";
import { getBrowserManager } from "./browser.js";
import { browserOpenAndExtract, browserSearch, browserCaptureScreenshot, getSearchBackendHealth } from "./search.js";

const linkMemoryByRef = new Map();
const linkMemoryByUrl = new Map();
let nextLinkRef = 1;
const screenshotDownloadById = new Map();
const screenshotStorageDir = path.join(process.cwd(), "screenshots");
const TOOL_CACHE_TTL_MS = 10 * 60 * 1000;
const SCREENSHOT_DOWNLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const MAX_LINK_MEMORY_ENTRIES = 2000;
const MAX_SCREENSHOT_DOWNLOADS = 200;
const MAX_TOOL_CACHE_ENTRIES = 200;
const toolResultCache = {
  web_search: new Map(),
  web_open_page: new Map()
};

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function getCacheKey(args) {
  return stableStringify(args || {});
}

function getCachedToolResult(toolName, args) {
  const bucket = toolResultCache[toolName];
  if (!bucket) return null;
  pruneToolCacheBucket(bucket);
  const key = getCacheKey(args);
  const entry = bucket.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    bucket.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedToolResult(toolName, args, value) {
  const bucket = toolResultCache[toolName];
  if (!bucket) return;
  pruneToolCacheBucket(bucket);
  const key = getCacheKey(args);
  bucket.set(key, {
    value,
    expiresAt: Date.now() + TOOL_CACHE_TTL_MS
  });
  while (bucket.size > MAX_TOOL_CACHE_ENTRIES) {
    const oldestKey = bucket.keys().next().value;
    if (!oldestKey) break;
    bucket.delete(oldestKey);
  }
}

function pruneToolCacheBucket(bucket) {
  const now = Date.now();
  for (const [key, entry] of bucket.entries()) {
    if (!entry || entry.expiresAt <= now) {
      bucket.delete(key);
    }
  }
}

function asMarkdownContent(text) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

function truncateForDisplay(value, maxChars = 400) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function assertString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid input: ${field} must be a non-empty string`);
  }
}

function parseEngineList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

function normalizeSearchEngineSelection(engines, engine) {
  const fromList = parseEngineList(engines);
  const fromSingle = typeof engine === "string" ? String(engine).trim().toLowerCase() : "";
  const requested = [...fromList, ...(fromSingle ? [fromSingle] : [])].filter(Boolean);
  if (!requested.length) return [];
  if (requested.includes("select_best")) return [];
  return fromList.length ? fromList : [fromSingle];
}

function parseQueryList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function parseSearchLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(20, Math.floor(parsed));
}

function parseMaxChars(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(200000, Math.floor(parsed));
}

function parseBooleanParam(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid input: ${field} must be a positive number`);
  }
  return Math.floor(parsed);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendMarkdown(res, status, payload) {
  res.writeHead(status, { "content-type": "text/markdown; charset=utf-8" });
  res.end(payload);
}

const LOG_MAP = {
  booting:               ["🚀", "Server starting"],
  "boot.config":         ["⚙️",  (p) => `Search route warmup engines: ${p?.searchRouteWarmupEngines?.join(", ") || "?"}`],
  "boot.ready":          ["🚀",  (p) => p?.transport === "stdio" ? "Ready (stdio)" : `Ready  ${(p?.host || "?").replace(/^https?:\/\//, "")}:${p?.port || "?"}`],
  "prelaunch.ready":     ["✅",  "Browser warmed"],
  "prelaunch.error":     ["❌",  "Browser warmup failed"],
  "boot.start":          ["", ""],
  shutdown:              ["🛑",  "Shutting down"],
  "shutdown.error":      ["❌",  "Shutdown error"],
  "process.uncaught_exception":  ["💥", "Uncaught exception"],
  "process.unhandled_rejection": ["⚠️", "Unhandled rejection"]
};

function logEvent(label, payload) {
  const entry = LOG_MAP[label];
  if (!entry) return;
  const [emoji, msg] = entry;
  const text = typeof msg === "function" ? msg(payload) : msg;
  if (!text && !emoji) return;
  if (!text) { console.error(`${emoji}  ${label}`); return; }
  console.error(`${emoji}  ${text}`);
}

function truncateStr(s, max = 80) {
  if (!s || s.length <= max) return s || "";
  return s.slice(0, max) + "...";
}

function getDomain(u) {
  try { return new URL(u).hostname; } catch { return ""; }
}

function mcpRequestSummary(body) {
  if (!body) return "?";
  const m = body?.method || "";
  if (m !== "tools/call") return m;
  const name = body?.params?.name || "?";
  const args = body?.params?.arguments || {};
  const isPage = name === "web_open_page" || name === "web_page_screenshot";
  const parts = [name];
  if (args.query) parts.push(`"${truncateStr(args.query, 60)}"`);
  if (args.queries) parts.push(truncateStr(args.queries.join(" | "), 60));
  if (args.url) {
    const domain = getDomain(args.url);
    parts.push(isPage && domain ? domain : truncateStr(args.url, 60));
  }
  if (args.urls) {
    const domain = getDomain(args.urls[0]);
    parts.push(`${args.urls.length} urls${domain ? ` · ${domain}` : ""}`);
  }
  if (args.ref_id !== void 0) parts.push(`ref #${args.ref_id}`);
  if (args.ref_ids) parts.push(`${args.ref_ids.length} refs`);
  const eng = normalizeSearchEngineSelection(args.engines, args.engine).join(",");
  if (eng) parts.push(`[${eng}]`);
  if (args.limit && args.limit !== 5) parts.push(`limit=${args.limit}`);
  if (args.maxChars && args.maxChars !== 8000) parts.push(`maxc=${args.maxChars}`);
  if (args.format) parts.push(args.format);
  if (args.fullPage === false) parts.push("no-fullpage");
  return parts.join("  ");
}

function firstResultTitle(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("- [ref_id")) {
      const match = lines[i].match(/\*\*(.+?)\*\*/);
      if (match) return truncateStr(match[1], 60);
    }
  }
  return "";
}

function extractDomains(text) {
  const domains = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.match(/URL:\s*(https?:\/\/([^\/\s]+))/);
    if (m && !domains.includes(m[2])) domains.push(m[2]);
  }
  if (!domains.length) {
    const m = text.match(/\[ref_id \d+\].*?\]\s+(https?:\/\/([^\/\s]+))/);
    if (m && !domains.includes(m[2])) domains.push(m[2]);
  }
  return domains.join(", ");
}

function mcpResponseSummary(resp) {
  if (!resp) return "";
  if (resp.error) return `error: ${truncateStr(resp.error.message || "", 80)}`;
  const result = resp.result;
  if (!result) return "";
  if (result.isError) return "error";
  const text = result?.content?.[0]?.text || "";
  if (!text) return "ok";
  const refs = text.match(/\[ref_id \d+\]/g);
  if (refs) {
    const hint = firstResultTitle(text);
    const domains = extractDomains(text);
    const domainsPart = domains ? ` · ${domains}` : "";
    return `${refs.length} results${hint ? ` · “${hint}”` : ""}${domainsPart}`;
  }
  const okCount = (text.match(/Status: Success/g) || []).length;
  const failCount = (text.match(/Status: Failed/g) || []).length;
  if (okCount || failCount) {
    const domains = extractDomains(text);
    const domainsPart = domains ? ` · ${domains}` : "";
    return `${okCount + failCount} pages (${okCount} ok, ${failCount} err)${domainsPart}`;
  }
  return `${Math.round(text.length / 1000)}k chars`;
}

function summarizeToolArgs(tool, args = {}) {
  const base = { tool, argKeys: Object.keys(args || {}) };

  if (tool === "web_search") {
    const single = typeof args.query === "string" ? args.query.trim() : "";
    const multi = Array.isArray(args.queries)
      ? args.queries.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const terms = [...new Set([single, ...multi].filter(Boolean))];
    return {
      ...base,
      terms,
      termCount: terms.length,
      limit: parseSearchLimit(args.limit, 5),
      engines: normalizeSearchEngineSelection(args.engines, args.engine)
    };
  }

  if (tool === "web_open_page" || tool === "web_page_screenshot") {
    const urlCount = Array.isArray(args.urls)
      ? args.urls.map((item) => String(item || "").trim()).filter(Boolean).length
      : typeof args.url === "string" && args.url.trim()
        ? 1
        : 0;
    const refCount = Array.isArray(args.ref_ids)
      ? args.ref_ids.filter((item) => item !== undefined && item !== null && String(item).trim()).length
      : args.ref_id !== undefined && args.ref_id !== null && String(args.ref_id).trim()
        ? 1
        : 0;
    return {
      ...base,
      urlCount,
      refCount,
      maxChars: tool === "web_open_page" ? parseMaxChars(args.maxChars, 8000) : undefined,
      format: tool === "web_page_screenshot" ? (args.format || "png") : undefined,
      fullPage: tool === "web_page_screenshot" ? (args.fullPage === undefined ? true : Boolean(args.fullPage)) : undefined
    };
  }

  return base;
}

function createExecutionTimer() {
  const startedAtMs = performance.now();
  return {
    step() { return performance.now(); },
    end() { return Math.max(0, Math.round(performance.now() - startedAtMs)); }
  };
}

function logBootConfig(config) {
  logEvent("boot.config", { searchRouteWarmupEngines: config.searchRouteWarmupEngines });
}

function truncateLink(value, maxChars = 50) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function cleanTitle(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const withoutUrl = text.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
  return withoutUrl || text;
}

function buildApiBaseUrl(config) {
  let host = String(config?.mcpApiHost || "http://localhost").trim();
  if (!/^https?:\/\//i.test(host)) {
    host = `http://${host}`;
  }
  host = host.replace(/\/+$/, "");
  const hasPort = /:\d+$/.test(host);
  if (!hasPort && config?.mcpApiPort) {
    host = `${host}:${config.mcpApiPort}`;
  }
  return host;
}

function resolveDisplayPath(filePath, prefix) {
  if (!filePath) return null;
  if (!prefix) return filePath;
  const relative = path.relative(screenshotStorageDir, filePath);
  const trimmed = prefix.replace(/[\\/]+$/, "");
  const suffix = path.basename(trimmed);
  if (suffix.toLowerCase() === "screenshots") {
    return path.join(trimmed, relative);
  }
  return path.join(trimmed, "screenshots", relative);
}

async function storeScreenshotDownload(entry, config, { enableDownload }) {
  if (!entry?.screenshotBase64) return null;
  await pruneScreenshotDownloads();
  await pruneStoredScreenshotFiles();
  await fs.mkdir(screenshotStorageDir, { recursive: true });
  const format = entry?.format === "jpeg" ? "jpeg" : "png";
  const extension = format === "jpeg" ? "jpg" : "png";
  const downloadId = randomUUID();
  const filename = `screenshot-${downloadId}.${extension}`;
  const filePath = path.join(screenshotStorageDir, filename);
  const buffer = Buffer.from(entry.screenshotBase64, "base64");
  await fs.writeFile(filePath, buffer);

  let downloadUrl = null;
  if (enableDownload) {
    screenshotDownloadById.set(downloadId, {
      path: filePath,
      filename,
      contentType: entry?.contentType || (format === "jpeg" ? "image/jpeg" : "image/png"),
      createdAt: Date.now()
    });
    const baseUrl = buildApiBaseUrl(config);
    downloadUrl = `${baseUrl}/download/${downloadId}`;
  }

  return {
    downloadId,
    downloadUrl,
    bytes: buffer.length,
    filePath
  };
}

function rememberLink(url) {
  const normalized = String(url || "").trim();
  if (!normalized) return null;

  pruneLinkMemory();

  const existingRef = linkMemoryByUrl.get(normalized);
  if (existingRef) return existingRef;

  const ref = nextLinkRef;
  nextLinkRef += 1;
  linkMemoryByUrl.set(normalized, ref);
  linkMemoryByRef.set(ref, normalized);
  pruneLinkMemory();
  return ref;
}

function pruneLinkMemory() {
  while (linkMemoryByRef.size > MAX_LINK_MEMORY_ENTRIES) {
    const oldestRef = linkMemoryByRef.keys().next().value;
    if (oldestRef === undefined) break;
    const rememberedUrl = linkMemoryByRef.get(oldestRef);
    linkMemoryByRef.delete(oldestRef);
    if (rememberedUrl) {
      linkMemoryByUrl.delete(rememberedUrl);
    }
  }
}

async function deleteScreenshotRecord(downloadId, record) {
  screenshotDownloadById.delete(downloadId);
  if (!record?.path) return;
  try {
    await fs.rm(record.path, { force: true });
  } catch {
    // ignore cleanup errors
  }
}

async function pruneScreenshotDownloads() {
  const now = Date.now();
  for (const [downloadId, record] of screenshotDownloadById.entries()) {
    if (!record?.createdAt || now - record.createdAt > SCREENSHOT_DOWNLOAD_TTL_MS) {
      await deleteScreenshotRecord(downloadId, record);
    }
  }

  while (screenshotDownloadById.size > MAX_SCREENSHOT_DOWNLOADS) {
    const oldestEntry = screenshotDownloadById.entries().next().value;
    if (!oldestEntry) break;
    const [downloadId, record] = oldestEntry;
    await deleteScreenshotRecord(downloadId, record);
  }
}

async function pruneStoredScreenshotFiles() {
  try {
    const entries = await fs.readdir(screenshotStorageDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("screenshot-")) continue;
      const filePath = path.join(screenshotStorageDir, entry.name);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > SCREENSHOT_DOWNLOAD_TTL_MS) {
          await fs.rm(filePath, { force: true });
        }
      } catch {
        // ignore cleanup errors
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

function decorateResultLinks(results) {
  if (!Array.isArray(results)) return results;

  return results.map((item) => {
    const rawUrl = String(item?.url || "").trim();
    if (!rawUrl) return item;

    const ref = rememberLink(rawUrl);
    const display = `[${ref}] ${truncateLink(rawUrl, 50)}`;

    return {
      ...item,
      ref_id: ref,
      link: display,
      url: display
    };
  });
}

function decorateSearchPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;

  const output = {
    ...payload,
    results: decorateResultLinks(payload.results)
  };

  if (Array.isArray(payload.queryResults)) {
    output.queryResults = payload.queryResults.map((entry) => ({
      ...entry,
      results: decorateResultLinks(entry.results)
    }));
  }

  return output;
}

function formatSearchMarkdown(payload) {
  const lines = [];

  if (payload?.query) {
    lines.push(`**Query:** ${payload.query}`);
  } else if (Array.isArray(payload?.queries) && payload.queries.length) {
    lines.push(`**Queries:** ${payload.queries.join(", ")}`);
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (results.length) {
    lines.push("", `**Results (${results.length}):**`);
    results.forEach((result, index) => {
      const refId = result?.ref_id;
      const refLabel = refId ? `[ref_id ${refId}]` : `${index + 1}.`;
      const titleText = cleanTitle(result?.title || "");
      const title = titleText ? `**${titleText}**` : "Untitled";
      const link = result?.link || result?.url || "";
      const snippet = truncateForDisplay(result?.snippet || "", 450);
      const queryVariants = Array.isArray(result?.queryVariants) && result.queryVariants.length
        ? ` _(queries: ${result.queryVariants.join(", ")})_`
        : "";

      const bullet = link ? `- ${refLabel} ${title} — ${link}${queryVariants}` : `- ${refLabel} ${title}${queryVariants}`;
      lines.push(bullet.trim());
      if (snippet) {
        lines.push(`  - ${snippet}`);
      }
    });
    lines.push(
      "",
      "Use `ref_id` with `/extract?ref_id=<id>` or `/screenshot?ref_id=<id>`, or MCP tools `web_open_page` / `web_page_screenshot` with `ref_id`."
    );
  } else {
    lines.push("", "No results returned.");
  }

  if (Array.isArray(payload?.directAnswers) && payload.directAnswers.length) {
    lines.push("", "**Direct Answers:**");
    payload.directAnswers.forEach((answer) => {
      const source = answer?.source ? answer.source : "answer";
      const snippet = truncateForDisplay(answer?.text || "", 400);
      const link = answer?.url ? ` (${answer.url})` : "";
      lines.push(`- ${source}${link}`);
      if (snippet) {
        lines.push(`  - ${snippet}`);
      }
    });
  }

  if (Array.isArray(payload?.errors) && payload.errors.length) {
    lines.push("", "**Errors:**");
    payload.errors.forEach((entry) => {
      if (!entry?.error) return;
      lines.push(`- ${entry.error}`);
    });
  }

  return lines.filter(Boolean).join("\n");
}

function formatSearchResponse(payload) {
  return asMarkdownContent(formatSearchMarkdown(payload));
}

function normalizeResultEntries(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.results)) return payload.results;
  if (typeof payload === "object" && ("ok" in payload || "text" in payload || "error" in payload)) {
    return [payload];
  }
  return [];
}

async function applyScreenshotStorage(payload, config) {
  const wantsDownload = Boolean(config?.enableScreenshotDownloadLink);
  const wantsPath = Boolean(config?.screenshotPathPrefix);
  if (!wantsDownload && !wantsPath) return payload;
  const entries = normalizeResultEntries(payload);
  if (!entries.length) return payload;

  for (const entry of entries) {
    if (!entry?.ok || !entry?.screenshotBase64) continue;
    const download = await storeScreenshotDownload(entry, config, { enableDownload: wantsDownload });
    if (!download) continue;
    if (wantsDownload) {
      entry.downloadId = download.downloadId;
      entry.downloadUrl = download.downloadUrl;
    }
    entry.bytes = download.bytes;
    if (wantsPath) {
      entry.filePath = resolveDisplayPath(download.filePath, config.screenshotPathPrefix);
    }
    delete entry.screenshotBase64;
  }

  return payload;
}

function formatOpenPageResponse(payload) {
  const entries = normalizeResultEntries(payload);
  if (!entries.length) {
    return asMarkdownContent("No page data available.");
  }

  const successCount = entries.filter((entry) => entry?.ok !== false).length;
  const total = payload?.count ?? entries.length;
  const lines = [`Processed ${total} page(s); ${successCount} succeeded.`];

  entries.forEach((entry, index) => {
    const refLabel = entry?.ref_id ? `[${entry.ref_id}]` : `#${index + 1}`;
    const title = entry?.title || entry?.url || `Page ${index + 1}`;
    lines.push("", `### ${refLabel} ${title}`);
    lines.push(`- Status: ${entry?.ok === false ? "Failed" : "Success"}`);
    if (entry?.url) {
      lines.push(`- URL: ${entry.url}`);
    }
    if (entry?.error) {
      lines.push(`- Error: ${entry.error}`);
      return;
    }
    if (entry?.text) {
      lines.push("", entry.text.trim());
    }
  });

  return asMarkdownContent(lines.join("\n"));
}

function formatScreenshotResponse(payload) {
  const entries = normalizeResultEntries(payload);
  if (!entries.length) {
    return asMarkdownContent("No screenshot data available.");
  }

  const successCount = entries.filter((entry) => entry?.ok !== false).length;
  const total = payload?.count ?? entries.length;
  const lines = [`Captured ${total} screenshot(s); ${successCount} succeeded.`];

  entries.forEach((entry, index) => {
    const refLabel = entry?.ref_id ? `[${entry.ref_id}]` : `#${index + 1}`;
    const title = entry?.title || entry?.url || `Screenshot ${index + 1}`;
    lines.push("", `### ${refLabel} ${title}`);
    lines.push(`- Status: ${entry?.ok === false ? "Failed" : "Success"}`);
    if (entry?.url) {
      lines.push(`- URL: ${entry.url}`);
    }
    if (entry?.error) {
      lines.push(`- Error: ${entry.error}`);
      return;
    }
    if (entry?.contentType) {
      lines.push(`- Content-Type: ${entry.contentType}`);
    }
    if (entry?.bytes) {
      lines.push(`- Size: ${entry.bytes} bytes`);
    }
    if (entry?.filePath) {
      lines.push(`- File: ${entry.filePath}`);
    }
    if (entry?.downloadUrl) {
      lines.push(`- Download: ${entry.downloadUrl}`);
    }
    if (!entry?.downloadUrl && entry?.screenshotBase64) {
      const mime = entry.contentType || (entry.format === "jpeg" ? "image/jpeg" : "image/png");
      const dataUrl = `data:${mime};base64,${entry.screenshotBase64}`;
      lines.push("", `![${title}](${dataUrl})`);
    }
  });

  return asMarkdownContent(lines.join("\n"));
}

function resolveOpenTarget(args) {
  const normalizedRef = args?.ref_id ?? args?.ref;
  const normalizedRefs = args?.ref_ids ?? args?.refs;
  const hasUrl = args && Object.prototype.hasOwnProperty.call(args, "url");
  const hasUrls = args && Object.prototype.hasOwnProperty.call(args, "urls");
  const hasRef = args && (Object.prototype.hasOwnProperty.call(args, "ref_id") || Object.prototype.hasOwnProperty.call(args, "ref"));
  const hasRefs = args && (Object.prototype.hasOwnProperty.call(args, "ref_ids") || Object.prototype.hasOwnProperty.call(args, "refs"));

  if (hasUrls) {
    if (Array.isArray(args.urls) && args.urls.length) {
      const normalizedUrls = args.urls.map((item) => {
        assertString(item, "urls[]");
        return String(item).trim();
      }).filter(Boolean);

      if (normalizedUrls.length) {
        return normalizedUrls;
      }
    }
  }

  if (hasRefs) {
    if (Array.isArray(normalizedRefs) && normalizedRefs.length) {
      return normalizedRefs.map((item) => {
        const ref = parsePositiveInt(item, "ref_ids[]");
        const remembered = linkMemoryByRef.get(ref);
        if (!remembered) {
          throw new Error(`No link found in memory for ref ${ref}`);
        }
        return remembered;
      });
    }
  }

  if (hasRef) {
    if (normalizedRef !== undefined && normalizedRef !== null && String(normalizedRef).trim() && Number(normalizedRef) > 0) {
      const ref = parsePositiveInt(normalizedRef, "ref_id");
      const remembered = linkMemoryByRef.get(ref);
      if (!remembered) {
        throw new Error(`No link found in memory for ref ${ref}`);
      }
      return [remembered];
    }
  }

  if (hasUrl) {
    if (typeof args.url === "string" && args.url.trim()) {
      return [String(args.url).trim()];
    }
  }

  throw new Error("Invalid input: provide one of url, urls, ref_id/ref, or ref_ids/refs");
}

function buildBatchResultPayload(targetUrls, opened) {
  const payload = {
    count: opened.length,
    successCount: opened.filter((item) => item.ok).length,
    results: opened
  };

  if (targetUrls.length === 1 && opened[0]?.ok) {
    return { ...opened[0], results: undefined };
  }

  return payload;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const values = Array.from(items || []);
  const limit = Math.max(1, Math.min(concurrency, values.length || 1));
  const results = new Array(values.length);
  let cursor = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

async function openTargetsParallel(targetUrls, maxChars, maxParallel, includeSeoAnalysis = false) {
  const opened = await mapWithConcurrency(
    targetUrls,
    maxParallel,
    async (targetUrl, index) => {
      try {
        const page = await browserOpenAndExtract({ url: targetUrl, maxChars, includeSeoAnalysis });
        return {
          index,
          ok: true,
          ref_id: rememberLink(targetUrl),
          ...page
        };
      } catch (error) {
        return {
          index,
          ok: false,
          ref_id: rememberLink(targetUrl),
          url: targetUrl,
          error: String(error?.message || error)
        };
      }
    }
  );

  return buildBatchResultPayload(targetUrls, opened);
}

async function captureScreenshotsParallel(targetUrls, maxParallel, captureOptions = {}) {
  const opened = await mapWithConcurrency(
    targetUrls,
    maxParallel,
    async (targetUrl, index) => {
      try {
        const capture = await browserCaptureScreenshot({ url: targetUrl, ...captureOptions });
        return {
          index,
          ok: true,
          ref_id: rememberLink(targetUrl),
          ...capture
        };
      } catch (error) {
        return {
          index,
          ok: false,
          ref_id: rememberLink(targetUrl),
          url: targetUrl,
          error: String(error?.message || error)
        };
      }
    }
  );

  return buildBatchResultPayload(targetUrls, opened);
}

function parseHttpExtractTargets(searchParams) {
  const refsParam = String(searchParams.get("ref_ids") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (refsParam.length) {
    return refsParam.map((item) => {
      const ref = parsePositiveInt(item, "ref_ids[]");
      const remembered = linkMemoryByRef.get(ref);
      if (!remembered) {
        throw new Error(`No link found in memory for ref ${ref}`);
      }
      return remembered;
    });
  }

  const urlsParam = String(searchParams.get("urls") || "")
    .split("||")
    .map((item) => item.trim())
    .filter(Boolean);
  if (urlsParam.length) {
    return urlsParam;
  }

  const refParam = searchParams.get("ref_id");
  if (refParam && refParam.trim()) {
    const ref = parsePositiveInt(refParam, "ref_id");
    const remembered = linkMemoryByRef.get(ref);
    if (!remembered) {
      throw new Error(`No link found in memory for ref ${ref}`);
    }
    return [remembered];
  }

  const urlParam = String(searchParams.get("url") || "").trim();
  if (urlParam) return [urlParam];

  throw new Error("Missing url, urls, ref_id, or ref_ids query parameter");
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_HTTP_BODY_BYTES) {
      const error = new Error(`Request body too large (max ${MAX_HTTP_BODY_BYTES} bytes)`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }

  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function getToolsListResponse() {
  return {
    tools: [
      {
        name: "web_search",
        description:
          "Search the web for any user request and return ranked results with numeric result ids. By default, send `engine: \"select_best\"` or omit engine/engines entirely unless the user explicitly asks about engines or requests a specific one. `select_best` means the server will choose the best engine automatically using its fallback and circuit-breaker logic. If `select_best` is combined with specific engines, `select_best` takes priority. Use this for general research, fact lookup, docs, tutorials, comparisons, news, and discovery before opening pages.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            queries: {
              type: "array",
              items: { type: "string" },
              description: "Multiple query variations to run"
            },
            limit: { type: "number", default: 5 },
            engines: {
              type: "array",
              items: {
                type: "string",
                enum: ["select_best", "duckduckgo_api", "bing_lp", "mojeek_lp", "google_ch", "duckduckgo_ch"]
              },
              description: "Specific search engines to run. Prefer `select_best` by default. Only send concrete engines if the user explicitly requests certain engines or asks about engine behavior. If `select_best` appears anywhere in this list, it takes priority and automatic fallback/circuit-breaker selection is used."
            },
            engine: {
              type: "string",
              default: "select_best",
              enum: ["select_best", "duckduckgo_api", "bing_lp", "mojeek_lp", "google_ch", "duckduckgo_ch"],
              description: "Preferred default: `select_best`. Only send a concrete engine if the user explicitly requests one engine or asks about engine behavior. `select_best` uses automatic fallback and circuit-breaker logic."
            }
          },
          description: "Provide query (string) or queries (string[]). Use queries for multiple search variations.",
          additionalProperties: false
        }
      },
      {
        name: "web_open_page",
        description:
          "Open one or more pages and return clean readable text for analysis. Use this after web_search via ref_id/ref_ids or with direct url/urls for summarization, extraction, QA, and synthesis.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            urls: {
              type: "array",
              items: { type: "string" },
              description: "Multiple URLs to open in parallel"
            },
            ref_id: {
              type: "number",
              description: "Result id returned by a previous web_search call"
            },
            ref_ids: {
              type: "array",
              items: { type: "number" },
              description: "Multiple result ids returned by a previous web_search call"
            },
            maxChars: { type: "number", default: 8000 }
          },
          description: "Provide one of: url, urls, ref_id, or ref_ids. Prefer ref_id/ref_ids from web_search when available.",
          additionalProperties: false
        }
      },
      {
        name: "web_page_screenshot",
        description:
          "Open one or more pages and return base64-encoded full-page screenshots (PNG or JPEG). Use this to capture visual snapshots of results discovered via web_search.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            urls: {
              type: "array",
              items: { type: "string" },
              description: "Multiple URLs to open in parallel"
            },
            ref_id: {
              type: "number",
              description: "Result id returned by a previous web_search call"
            },
            ref_ids: {
              type: "array",
              items: { type: "number" },
              description: "Multiple result ids returned by a previous web_search call"
            },
            format: {
              type: "string",
              enum: ["png", "jpeg"],
              default: "png",
              description: "Image format for the screenshot"
            },
            quality: {
              type: "number",
              minimum: 1,
              maximum: 100,
              description: "JPEG quality (ignored for PNG)"
            },
            fullPage: {
              type: "boolean",
              default: true,
              description: "Capture the entire page, not just the viewport"
            }
          },
          description: "Provide one of: url, urls, ref_id, or ref_ids. Prefer ref_id/ref_ids from web_search when available.",
          additionalProperties: false
        }
      }
    ]
  };
}

async function handleToolCall(name, args = {}) {
  const timer = createExecutionTimer("mcp.tool.timing", {
    tool: name,
    mode: "mcp"
  });
  let mark = performance.now();

  if (name === "web_search") {
    const cached = getCachedToolResult(name, args);
    if (cached) {
      timer.step("cache_hit", mark);
      timer.end({ cacheHit: true, status: "ok" });
      return cached;
    }
    mark = timer.step("cache_miss", mark);
    const queries = parseQueryList(args.queries);
    if (!queries.length) {
      assertString(args.query, "query");
    }
    const limit = parseSearchLimit(args.limit, 5);
    const engines = normalizeSearchEngineSelection(args.engines, args.engine);
    mark = timer.step("validate_inputs", mark);

    const results = await runWithHangGuard(`mcp:${name}`, () =>
      browserSearch({
        query: args.query,
        queries,
        limit,
        ...(engines.length ? { engines } : {})
      })
    );
    mark = timer.step("browser_search", mark);
    const response = formatSearchResponse(decorateSearchPayload(results));
    mark = timer.step("format_response", mark);
    setCachedToolResult(name, args, response);
    timer.step("cache_store", mark);
    timer.end({ cacheHit: false, status: "ok" });
    return response;
  }

  if (name === "web_open_page") {
    const cached = getCachedToolResult(name, args);
    if (cached) {
      timer.step("cache_hit", mark);
      timer.end({ cacheHit: true, status: "ok" });
      return cached;
    }
    mark = timer.step("cache_miss", mark);
    let targetUrls;
    try {
      targetUrls = resolveOpenTarget(args);
    } catch (error) {
      timer.step("resolve_targets_failed", mark);
      timer.end({ cacheHit: false, status: "error", error: String(error?.message || error) });
      logEvent("mcp.error", {
        tool: name,
        error: String(error?.message || error)
      });
      throw error;
    }
    mark = timer.step("resolve_targets", mark);
    const maxChars = parseMaxChars(args.maxChars, 8000);
    const includeSeoAnalysis = args.includeSeoAnalysis !== false;
    const manager = await getBrowserManager();
    mark = timer.step("prepare_execution", mark);
    const result = await runWithHangGuard(`mcp:${name}`, () =>
      openTargetsParallel(targetUrls, maxChars, manager.config.openPageMaxParallel, includeSeoAnalysis)
    );
    mark = timer.step("open_targets", mark);
    const response = formatOpenPageResponse(result);
    mark = timer.step("format_response", mark);
    setCachedToolResult(name, args, response);
    timer.step("cache_store", mark);
    timer.end({ cacheHit: false, status: "ok" });
    return response;
  }

  if (name === "web_page_screenshot") {
    let targetUrls;
    try {
      targetUrls = resolveOpenTarget(args);
    } catch (error) {
      timer.step("resolve_targets_failed", mark);
      timer.end({ status: "error", error: String(error?.message || error) });
      logEvent("mcp.error", {
        tool: name,
        error: String(error?.message || error)
      });
      throw error;
    }
    mark = timer.step("resolve_targets", mark);
    const manager = await getBrowserManager();
    const formatRaw = typeof args.format === "string" ? args.format.trim().toLowerCase() : "png";
    const format = formatRaw === "jpeg" ? "jpeg" : "png";
    let quality;
    if (typeof args.quality !== "undefined" && args.quality !== null) {
      quality = parsePositiveInt(args.quality, "quality");
      quality = Math.min(100, Math.max(1, quality));
    }
    const fullPage = args.fullPage === undefined ? true : Boolean(args.fullPage);
    mark = timer.step("prepare_execution", mark);

    const result = await runWithHangGuard(`mcp:${name}`, () =>
      captureScreenshotsParallel(targetUrls, manager.config.openPageMaxParallel, {
        format,
        fullPage,
        ...(quality ? { quality } : {})
      })
    );
    mark = timer.step("capture_screenshots", mark);
    await applyScreenshotStorage(result, manager.config);
    mark = timer.step("store_screenshots", mark);
    const response = formatScreenshotResponse(result);
    timer.step("format_response", mark);
    timer.end({ status: "ok" });
    return response;
  }

  timer.step("unknown_tool", mark);
  timer.end({ status: "error", error: `Unknown tool: ${name}` });
  throw new Error(`Unknown tool: ${name}`);
}

async function handleStatelessMcpPost(body) {
  const id = body?.id ?? null;
  const method = String(body?.method || "");

  // JSON-RPC notifications (no id) must not receive a response
  if (id === null && !body.hasOwnProperty("id")) {
    return null;
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "search-tools", version: "1.0.0" }
      }
    };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: getToolsListResponse() };
  }

  if (method === "tools/call") {
    const name = body?.params?.name;
    const args = body?.params?.arguments || {};
    const result = await handleToolCall(name, args);
    return { jsonrpc: "2.0", id, result };
  }

  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return null;
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`
    }
  };
}

function createMcpServer() {
  const server = new Server(
    {
      name: "search-tools",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const response = getToolsListResponse();
    logEvent("mcp.request", { method: "tools/list" });
    logEvent("mcp.response", { method: "tools/list", result: response });
    return response;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const summary = summarizeToolArgs(name, args);
    const sumTerms = summary.terms?.length ? summary.terms.join(" | ") : "";
    const sumTargets = summary.urlCount || summary.refCount
      ? `${summary.urlCount || 0} urls, ${summary.refCount || 0} refs` : "";

    console.error(`📡  ${name}${sumTerms ? " · " + truncateStr(sumTerms, 60) : ""}${sumTargets ? " · " + sumTargets : ""}`);

    try {
      const t0 = Date.now();
      const response = await handleToolCall(name, args);
      const ms = Date.now() - t0;
      const ok = response?.content?.[0]?.text || "";
      const okLabel = ok.length ? `${Math.round(ok.length / 1000)}k chars` : "";
      console.error(`📨  ${ms}ms${okLabel ? " · " + okLabel : ""}`);
      return response;
    } catch (error) {
      console.error(`❌  ${truncateStr(String(error?.message || error), 120)}`);
      const errorResponse = {
        isError: true,
        ...asMarkdownContent(`Error calling ${name}: ${String(error?.message || error)}`)
      };
      return errorResponse;
    }
  });

  return server;
}

async function maybeStartHttpServer(managerOverride) {
  const manager = managerOverride || (await getBrowserManager());
  if (!manager.config.enableHttpHealth && !manager.config.enableHttpMcp) return;

  const mcpTransports = new Map();
  let defaultMcpSessionId = null;

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const url = new URL(req.url || "/", "http://localhost");

      if (manager.config.enableHttpMcp && url.pathname === "/mcp") {
        const sessionId = typeof req.headers["mcp-session-id"] === "string"
          ? req.headers["mcp-session-id"]
          : undefined;
        const resolveTransport = () => {
          if (sessionId) {
            const bySessionId = mcpTransports.get(sessionId);
            if (bySessionId) return bySessionId;
          }

          if (defaultMcpSessionId && mcpTransports.has(defaultMcpSessionId)) {
            return mcpTransports.get(defaultMcpSessionId) || null;
          }

          if (mcpTransports.size >= 1) {
            return mcpTransports.values().next().value || null;
          }

          return null;
        };

        if (method === "POST") {
          const body = await readJsonBody(req);
          const reqSum = mcpRequestSummary(body);

          {
            // Only bind POST requests to an existing streamable session when the
            // client explicitly sends an MCP session id. Stateless JSON-RPC
            // requests should fall through to initialize/stateless handling.
            const existingTransport = sessionId ? resolveTransport() : null;
            if (existingTransport) {
              await existingTransport.handleRequest(req, res, body);
              return;
            }
          }

          const isToolCall = body?.method === "tools/call";
          const t0 = Date.now();
          if (reqSum && isToolCall) {
            console.error(`📡  ${reqSum}`);
          }

          if (isInitializeRequest(body)) {
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                defaultMcpSessionId = sid;
                mcpTransports.set(sid, transport);
              }
            });

            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid) {
                mcpTransports.delete(sid);
                if (defaultMcpSessionId === sid) {
                  defaultMcpSessionId = mcpTransports.keys().next().value || null;
                }
              }
            };

            const mcpServer = createMcpServer();
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, body);
            if (transport.sessionId) {
              defaultMcpSessionId = transport.sessionId;
              mcpTransports.set(transport.sessionId, transport);
            }
            console.error(`🤝  MCP initialized`);
            return;
          }

          const response = await handleStatelessMcpPost(body);
          const ms = Date.now() - t0;

          if (response === null) {
            res.writeHead(204);
            res.end();
            return;
          }

          const resSum = mcpResponseSummary(response);
          if (isToolCall && reqSum) {
            console.error(`📨  ${ms}ms${resSum ? " · " + resSum : ""}`);
          }
          sendJson(res, 200, response);
          return;
        }

        if (method === "GET" || method === "DELETE") {
          const transport = resolveTransport();
          if (!transport) {
            const message = sessionId
              ? "Bad Request: No valid session ID provided"
              : "Bad Request: Missing initialize request";
            sendJson(res, 400, {
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message
              },
              id: null
            });
            return;
          }

          if (!sessionId && transport.sessionId) {
            req.headers["mcp-session-id"] = transport.sessionId;
          }
          await transport.handleRequest(req, res);
          return;
        }

        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      if (method !== "GET") {
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/" || url.pathname === "/health") {
        const health = {
          ...(await manager.getHealth()),
          searchRouteCircuitBreakers: getSearchBackendHealth()
        };
        logEvent("http.request", { method, path: url.pathname });
        logEvent("http.response", { method, path: url.pathname, result: health });
        sendJson(res, 200, health);
        return;
      }

      if (url.pathname === "/search") {
        const timer = createExecutionTimer("http.timing", {
          mode: "http",
          method,
          path: url.pathname
        });
        let mark = performance.now();
        logEvent("http.request", {
          method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries())
        });
        const query = url.searchParams.get("q") || "";
        const multiQ = url.searchParams
          .getAll("q")
          .map((item) => item.trim())
          .filter(Boolean);
        const queriesParam = (url.searchParams.get("queries") || "")
          .split("||")
          .map((item) => item.trim())
          .filter(Boolean);
        const queries = [...new Set([...multiQ, ...queriesParam])];

        if (!query.trim() && !queries.length) {
          sendJson(res, 400, { ok: false, error: "Missing q or queries parameter" });
          return;
        }

        const limit = parseSearchLimit(url.searchParams.get("limit"), 5);
        const enginesParam = url.searchParams.get("engines");
        const engines = normalizeSearchEngineSelection(
          enginesParam
            ? enginesParam
                .split(",")
                .map((item) => item.trim().toLowerCase())
                .filter(Boolean)
            : [],
          url.searchParams.get("engine")
        );
        mark = timer.step("parse_inputs", mark);

        const payload = decorateSearchPayload(
          await runWithHangGuard("http:/search", () => browserSearch({ query, queries, limit, ...(engines.length ? { engines } : {}) }))
        );
        mark = timer.step("browser_search", mark);
        const markdown = formatSearchMarkdown(payload);
        timer.step("format_response", mark);
        timer.end({ status: "ok" });
        logEvent("http.response", { method, path: url.pathname, result: payload });
        sendMarkdown(res, 200, markdown);
        return;
      }

      if (url.pathname === "/extract") {
        const timer = createExecutionTimer("http.timing", {
          mode: "http",
          method,
          path: url.pathname
        });
        let mark = performance.now();
        logEvent("http.request", {
          method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries())
        });
        let targetUrls;
        try {
          targetUrls = parseHttpExtractTargets(url.searchParams);
        } catch (error) {
          logEvent("http.error", {
            method,
            path: url.pathname,
            error: String(error?.message || error)
          });
          timer.step("resolve_targets_failed", mark);
          timer.end({ status: "error", error: String(error?.message || error) });
          sendJson(res, 400, { ok: false, error: String(error?.message || error) });
          return;
        }
        mark = timer.step("resolve_targets", mark);

        const maxChars = parseMaxChars(url.searchParams.get("maxChars"), 8000);
        const payload = await runWithHangGuard("http:/extract", () =>
          openTargetsParallel(targetUrls, maxChars, manager.config.openPageMaxParallel)
        );
        mark = timer.step("open_targets", mark);
        const markdown = formatOpenPageResponse(payload).content[0].text;
        timer.step("format_response", mark);
        timer.end({ status: "ok" });
        logEvent("http.response", { method, path: url.pathname, result: payload });
        sendMarkdown(res, 200, markdown);
        return;
      }

      if (url.pathname === "/screenshot") {
        const timer = createExecutionTimer("http.timing", {
          mode: "http",
          method,
          path: url.pathname
        });
        let mark = performance.now();
        logEvent("http.request", {
          method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries())
        });
        let targetUrls;
        try {
          targetUrls = parseHttpExtractTargets(url.searchParams);
        } catch (error) {
          logEvent("http.error", {
            method,
            path: url.pathname,
            error: String(error?.message || error)
          });
          timer.step("resolve_targets_failed", mark);
          timer.end({ status: "error", error: String(error?.message || error) });
          sendJson(res, 400, { ok: false, error: String(error?.message || error) });
          return;
        }
        mark = timer.step("resolve_targets", mark);

        const formatParam = String(url.searchParams.get("format") || "png").trim().toLowerCase();
        const format = formatParam === "jpeg" ? "jpeg" : "png";
        const fullPage = parseBooleanParam(url.searchParams.get("fullPage"), true);
        const qualityParam = url.searchParams.get("quality");
        const quality = qualityParam ? parsePositiveInt(qualityParam, "quality") : null;
        const options = {
          format,
          fullPage,
          ...(quality ? { quality } : {})
        };
        mark = timer.step("parse_options", mark);

        const payload = await runWithHangGuard("http:/screenshot", () =>
          captureScreenshotsParallel(
            targetUrls,
            manager.config.openPageMaxParallel,
            options
          )
        );
        mark = timer.step("capture_screenshots", mark);
        await applyScreenshotStorage(payload, manager.config);
        mark = timer.step("store_screenshots", mark);
        const markdown = formatScreenshotResponse(payload).content[0].text;
        timer.step("format_response", mark);
        timer.end({ status: "ok" });
        logEvent("http.response", { method, path: url.pathname, result: payload });
        sendMarkdown(res, 200, markdown);
        return;
      }

      if (url.pathname.startsWith("/download/")) {
        if (!manager.config.enableScreenshotDownloadLink) {
          sendJson(res, 404, { ok: false, error: "Not found" });
          return;
        }

        const downloadId = decodeURIComponent(url.pathname.split("/").pop() || "").trim();
        await pruneScreenshotDownloads();
        const record = screenshotDownloadById.get(downloadId);
        if (!record) {
          sendJson(res, 404, { ok: false, error: "Unknown download id" });
          return;
        }

        try {
          const data = await fs.readFile(record.path);
          res.writeHead(200, {
            "content-type": record.contentType || "application/octet-stream",
            "content-disposition": `attachment; filename=\"${record.filename}\"`
          });
          res.end(data);
          return;
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
          return;
        }
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      logEvent("http.error", {
        method: req.method || "GET",
        path: req.url || "",
        error: String(error?.message || error)
      });
      sendJson(res, Number(error?.statusCode) || 500, { ok: false, error: String(error?.message || error) });
    }
  });

  server.listen(manager.config.mcpApiPort, "0.0.0.0", () => {
    logEvent("boot.ready", {
      transport: "http",
      host: manager.config.mcpApiHost,
      port: manager.config.mcpApiPort
    });
  });
}


logEvent("booting", { pid: process.pid });
const manager = await getBrowserManager();
logEvent("boot.start", { pid: process.pid });
logBootConfig(manager.config);

const HANG_TIMEOUT_CODE = "HANG_TIMEOUT";
let shutdownInProgress = false;

function createHangTimeoutError(label, timeoutMs) {
  const error = new Error(`Operation '${label}' timed out after ${timeoutMs}ms`);
  error.code = HANG_TIMEOUT_CODE;
  return error;
}

async function shutdownWithExit(exitCode, context = {}) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  if (Object.keys(context).length) {
    logEvent("shutdown", context);
  }

  try {
    await manager.shutdown();
  } catch (error) {
    logEvent("shutdown.error", {
      error: String(error?.message || error)
    });
  }

  process.exit(exitCode);
}

async function runWithHangGuard(label, task) {
  if (!manager.config.enableHangRestart) {
    return task();
  }

  const timeoutMs = manager.config.hangRestartTimeoutMs;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(createHangTimeoutError(label, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(), timeoutPromise]);
  } catch (error) {
    if (error?.code === HANG_TIMEOUT_CODE) {
      await shutdownWithExit(1, {
        reason: "hang_timeout",
        label,
        timeoutMs,
        error: String(error?.message || error)
      });
      return new Promise(() => {});
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

process.on("uncaughtException", async (error) => {
  logEvent("process.uncaught_exception", {
    error: String(error?.stack || error?.message || error)
  });
  if (manager.config.enableHangRestart) {
    await shutdownWithExit(1, { reason: "uncaught_exception" });
  }
});

process.on("unhandledRejection", async (reason) => {
  logEvent("process.unhandled_rejection", {
    error: String(reason?.stack || reason?.message || reason)
  });
  if (manager.config.enableHangRestart) {
    await shutdownWithExit(1, { reason: "unhandled_rejection" });
  }
});

manager.prelaunchIfConfigured().then(
  () => {
    if (manager.config.prelaunchBrowser) {
      logEvent("prelaunch.ready", { enabled: true });
    }
  },
  (error) => {
    logEvent("prelaunch.error", {
      error: String(error?.message || error)
    });
  }
);

await maybeStartHttpServer(manager);

if (manager.config.enableStdioMcp) {
  const stdioServer = createMcpServer();
  const transport = new StdioServerTransport();
  await stdioServer.connect(transport);
  logEvent("boot.ready", { transport: "stdio" });
}

if (!manager.config.enableStdioMcp && !manager.config.enableHttpMcp) {
  throw new Error("No MCP transport enabled. Set ENABLE_STDIO_MCP=1 and/or ENABLE_HTTP_MCP=1");
}

async function shutdown() {
  await shutdownWithExit(0, { reason: "signal" });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
