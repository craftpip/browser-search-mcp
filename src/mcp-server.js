import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest
} from "@modelcontextprotocol/sdk/types.js";
import { getBrowserManager } from "./browser.js";
import { browserOpenAndExtract, browserSearch, browserCaptureScreenshot } from "./search.js";

const linkMemoryByRef = new Map();
const linkMemoryByUrl = new Map();
let nextLinkRef = 1;
const screenshotDownloadById = new Map();
const screenshotStorageDir = path.join(process.cwd(), "screenshots");

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

function formatLogValue(value, maxChars) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatLogPayload(payload, maxChars = 4000) {
  if (payload === undefined || payload === null) return { inline: "", lines: [] };
  if (typeof payload === "string") return { inline: payload, lines: [] };
  if (typeof payload !== "object") return { inline: String(payload), lines: [] };

  const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
  if (!entries.length) return { inline: "", lines: [] };

  const lines = entries.map(([key, value]) => {
    let rendered = formatLogValue(value, maxChars);
    if (rendered.length > maxChars) {
      rendered = `${rendered.slice(0, maxChars)}...<truncated>`;
    }
    return `  ${key}: ${rendered}`;
  });

  if (entries.length <= 3) {
    const inline = entries
      .map(([key, value]) => {
        let rendered = formatLogValue(value, maxChars);
        if (rendered.length > maxChars) {
          rendered = `${rendered.slice(0, maxChars)}...<truncated>`;
        }
        return `${key}=${rendered}`;
      })
      .join(" ");
    return { inline, lines: [] };
  }

  return { inline: "", lines };
}

function logEvent(label, payload) {
  const { inline, lines } = formatLogPayload(payload);
  const timestamp = new Date().toISOString();
  if (lines.length) {
    console.error(`[${timestamp}] ${label}`);
    for (const line of lines) {
      console.error(line);
    }
    return;
  }
  const suffix = inline ? ` ${inline}` : "";
  console.error(`[${timestamp}] ${label}${suffix}`);
}

function logBootConfig(config) {
  logEvent("boot.config", {
    mcpApiHost: config.mcpApiHost,
    mcpApiPort: config.mcpApiPort,
    enableHttpHealth: config.enableHttpHealth,
    enableHttpMcp: config.enableHttpMcp,
    enableStdioMcp: config.enableStdioMcp,
    enableScreenshotDownloadLink: config.enableScreenshotDownloadLink,
    enableScreenshotPath: Boolean(config.screenshotPathPrefix),
    screenshotPathDisplay: config.screenshotPathPrefix || null,
    chromePath: config.chromePath,
    chromeUserDataDir: config.chromeUserDataDir,
    chromeProfileDir: config.chromeProfileDir,
    headless: config.headless,
    navWaitUntil: config.navWaitUntil,
    browserOpTimeoutMs: config.browserOpTimeoutMs,
    prelaunchBrowser: config.prelaunchBrowser,
    startupUrl: config.startupUrl,
    searchEngines: config.searchEngines,
    searchKeepMinWorkingWindows: config.searchKeepMinWorkingWindows,
    searchMaxWorkingWindows: config.searchMaxWorkingWindows,
    openPageMaxParallel: config.openPageMaxParallel,
    maxConcurrentPageOps: config.maxConcurrentPageOps
  });
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
      contentType: entry?.contentType || (format === "jpeg" ? "image/jpeg" : "image/png")
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

  const existingRef = linkMemoryByUrl.get(normalized);
  if (existingRef) return existingRef;

  const ref = nextLinkRef;
  nextLinkRef += 1;
  linkMemoryByUrl.set(normalized, ref);
  linkMemoryByRef.set(ref, normalized);
  return ref;
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
      ref,
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
      const refLabel = result?.ref ? `[result id ${result.ref}]` : `${index + 1}.`;
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
      "Use the result id with `/extract?ref=<id>` or `/screenshot?ref=<id>`, or MCP tools `web_open_page` / `web_page_screenshot` with `ref`."
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
    const refLabel = entry?.ref ? `[${entry.ref}]` : `#${index + 1}`;
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
    const refLabel = entry?.ref ? `[${entry.ref}]` : `#${index + 1}`;
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
  const hasUrl = args && Object.prototype.hasOwnProperty.call(args, "url");
  const hasUrls = args && Object.prototype.hasOwnProperty.call(args, "urls");
  const hasRef = args && Object.prototype.hasOwnProperty.call(args, "ref");
  const hasRefs = args && Object.prototype.hasOwnProperty.call(args, "refs");

  if (hasUrls) {
    if (!Array.isArray(args.urls) || !args.urls.length) {
      throw new Error("Invalid input: urls must be a non-empty array of URLs");
    }
    return args.urls.map((item) => {
      assertString(item, "urls[]");
      return String(item).trim();
    });
  }

  if (hasRefs) {
    if (!Array.isArray(args.refs) || !args.refs.length) {
      throw new Error("Invalid input: refs must be a non-empty array of numbers");
    }
    return args.refs.map((item) => {
      const ref = parsePositiveInt(item, "refs[]");
      const remembered = linkMemoryByRef.get(ref);
      if (!remembered) {
        throw new Error(`No link found in memory for ref ${ref}`);
      }
      return remembered;
    });
  }

  if (hasRef) {
    const ref = parsePositiveInt(args.ref, "ref");
    const remembered = linkMemoryByRef.get(ref);
    if (!remembered) {
      throw new Error(`No link found in memory for ref ${ref}`);
    }
    return [remembered];
  }

  if (hasUrl) {
    assertString(args.url, "url");
    return [String(args.url).trim()];
  }

  throw new Error("Invalid input: provide one of url, urls, ref, or refs");
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

async function openTargetsParallel(targetUrls, maxChars, maxParallel) {
  const opened = await mapWithConcurrency(
    targetUrls,
    maxParallel,
    async (targetUrl, index) => {
      try {
        const page = await browserOpenAndExtract({ url: targetUrl, maxChars });
        return {
          index,
          ok: true,
          ref: rememberLink(targetUrl),
          ...page
        };
      } catch (error) {
        return {
          index,
          ok: false,
          ref: rememberLink(targetUrl),
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
          ref: rememberLink(targetUrl),
          ...capture
        };
      } catch (error) {
        return {
          index,
          ok: false,
          ref: rememberLink(targetUrl),
          url: targetUrl,
          error: String(error?.message || error)
        };
      }
    }
  );

  return buildBatchResultPayload(targetUrls, opened);
}

function parseHttpExtractTargets(searchParams) {
  const refsParam = String(searchParams.get("refs") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (refsParam.length) {
    return refsParam.map((item) => {
      const ref = parsePositiveInt(item, "refs[]");
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

  const refParam = searchParams.get("ref");
  if (refParam && refParam.trim()) {
    const ref = parsePositiveInt(refParam, "ref");
    const remembered = linkMemoryByRef.get(ref);
    if (!remembered) {
      throw new Error(`No link found in memory for ref ${ref}`);
    }
    return [remembered];
  }

  const urlParam = String(searchParams.get("url") || "").trim();
  if (urlParam) return [urlParam];

  throw new Error("Missing url, urls, ref, or refs query parameter");
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks.map((item) => Buffer.from(item))).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function getToolsListResponse() {
  return {
    tools: [
      {
        name: "web_search",
        description:
          "Search the web for any user request and return ranked results with numeric result ids. Use this for general research, fact lookup, docs, tutorials, comparisons, news, and discovery before opening pages.",
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
                enum: ["bing", "duckduckgo", "google"]
              },
              description: "Search engines to run in parallel"
            },
            engine: {
              type: "string",
              enum: ["bing", "duckduckgo", "google"],
              default: "bing"
            }
          },
          description: "Provide query (string) or queries (string[]). Use queries for multiple search variations.",
          additionalProperties: false
        }
      },
      {
        name: "web_open_page",
        description:
          "Open one or more pages and return clean readable text for analysis. Use this after web_search via ref/refs or with direct url/urls for summarization, extraction, QA, and synthesis.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            urls: {
              type: "array",
              items: { type: "string" },
              description: "Multiple URLs to open in parallel"
            },
            ref: {
              type: "number",
              description: "Result id returned by a previous web_search call"
            },
            refs: {
              type: "array",
              items: { type: "number" },
              description: "Multiple result ids returned by a previous web_search call"
            },
            maxChars: { type: "number", default: 8000 }
          },
          description: "Provide one of: url, urls, ref, or refs. Prefer ref/refs from web_search when available.",
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
            ref: {
              type: "number",
              description: "Result id returned by a previous web_search call"
            },
            refs: {
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
          description: "Provide one of: url, urls, ref, or refs. Prefer ref/refs from web_search when available.",
          additionalProperties: false
        }
      }
    ]
  };
}

async function handleToolCall(name, args = {}) {
  if (name === "web_search") {
    const queries = parseQueryList(args.queries);
    if (!queries.length) {
      assertString(args.query, "query");
    }
    const limit = parseSearchLimit(args.limit, 5);
    const engines = parseEngineList(args.engines);
    if (!engines.length && typeof args.engine === "string") {
      engines.push(args.engine);
    }
    if (!engines.length) {
      engines.push("google");
    }

    const results = await browserSearch({
      query: args.query,
      queries,
      limit,
      engines
    });
    return formatSearchResponse(decorateSearchPayload(results));
  }

  if (name === "web_open_page") {
    let targetUrls;
    try {
      targetUrls = resolveOpenTarget(args);
    } catch (error) {
      logEvent("mcp.error", {
        tool: name,
        error: String(error?.message || error)
      });
      throw error;
    }
    const maxChars = parseMaxChars(args.maxChars, 8000);
    const manager = await getBrowserManager();
    const result = await openTargetsParallel(targetUrls, maxChars, manager.config.openPageMaxParallel);
    return formatOpenPageResponse(result);
  }

  if (name === "web_page_screenshot") {
    let targetUrls;
    try {
      targetUrls = resolveOpenTarget(args);
    } catch (error) {
      logEvent("mcp.error", {
        tool: name,
        error: String(error?.message || error)
      });
      throw error;
    }
    const manager = await getBrowserManager();
    const formatRaw = typeof args.format === "string" ? args.format.trim().toLowerCase() : "png";
    const format = formatRaw === "jpeg" ? "jpeg" : "png";
    let quality;
    if (typeof args.quality !== "undefined" && args.quality !== null) {
      quality = parsePositiveInt(args.quality, "quality");
      quality = Math.min(100, Math.max(1, quality));
    }
    const fullPage = args.fullPage === undefined ? true : Boolean(args.fullPage);

    const result = await captureScreenshotsParallel(targetUrls, manager.config.openPageMaxParallel, {
      format,
      fullPage,
      ...(quality ? { quality } : {})
    });
    await applyScreenshotStorage(result, manager.config);
    return formatScreenshotResponse(result);
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleStatelessMcpPost(body) {
  const id = body?.id ?? null;
  const method = String(body?.method || "");

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

  if (method === "notifications/initialized") {
    return { jsonrpc: "2.0", id, result: {} };
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
    logEvent("mcp.request", { method: "tools/list", params: {} });
    logEvent("mcp.response", { method: "tools/list", result: response });
    return response;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    logEvent("mcp.request", { method: "tools/call", tool: name, arguments: args });

    try {
      const response = await handleToolCall(name, args);
      logEvent("mcp.response", { method: "tools/call", tool: name, result: response });
      return response;
    } catch (error) {
      const errorResponse = {
        isError: true,
        ...asMarkdownContent(`Error calling ${name}: ${String(error?.message || error)}`)
      };
      logEvent("mcp.response", { method: "tools/call", tool: name, result: errorResponse });
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
          logEvent("http.mcp.request", { method, path: url.pathname, sessionId: sessionId || null, body });

          {
            const existingTransport = resolveTransport();
            if (existingTransport) {
              if (!sessionId && existingTransport.sessionId) {
                req.headers["mcp-session-id"] = existingTransport.sessionId;
              }
              await existingTransport.handleRequest(req, res, body);
              return;
            }
          }

          const response = await handleStatelessMcpPost(body);
          logEvent("http.mcp.response", { method, path: url.pathname, stateless: true, result: response });
          sendJson(res, 200, response);
          return;

          if (!isInitializeRequest(body)) {
            sendJson(res, 400, {
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Bad Request: Missing initialize request"
              },
              id: null
            });
            return;
          }

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
        const health = await manager.getHealth();
        logEvent("http.request", { method, path: url.pathname });
        logEvent("http.response", { method, path: url.pathname, result: health });
        sendJson(res, 200, health);
        return;
      }

      if (url.pathname === "/search") {
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
        const engines = enginesParam
          ? enginesParam
              .split(",")
              .map((item) => item.trim().toLowerCase())
              .filter(Boolean)
          : [];
        const engineParam = String(url.searchParams.get("engine") || "")
          .trim()
          .toLowerCase();
        if (!engines.length && engineParam) {
          engines.push(engineParam);
        }
        if (!engines.length) {
          engines.push("google");
        }

        const payload = decorateSearchPayload(await browserSearch({ query, queries, limit, engines }));
        const markdown = formatSearchMarkdown(payload);
        logEvent("http.response", { method, path: url.pathname, result: payload });
        sendMarkdown(res, 200, markdown);
        return;
      }

      if (url.pathname === "/extract") {
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
          sendJson(res, 400, { ok: false, error: String(error?.message || error) });
          return;
        }

        const maxChars = parseMaxChars(url.searchParams.get("maxChars"), 8000);
        const payload = await openTargetsParallel(targetUrls, maxChars, manager.config.openPageMaxParallel);
        const markdown = formatOpenPageResponse(payload).content[0].text;
        logEvent("http.response", { method, path: url.pathname, result: payload });
        sendMarkdown(res, 200, markdown);
        return;
      }

      if (url.pathname === "/screenshot") {
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
          sendJson(res, 400, { ok: false, error: String(error?.message || error) });
          return;
        }

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

        const payload = await captureScreenshotsParallel(
          targetUrls,
          manager.config.openPageMaxParallel,
          options
        );
        await applyScreenshotStorage(payload, manager.config);
        const markdown = formatScreenshotResponse(payload).content[0].text;
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
      sendJson(res, 500, { ok: false, error: String(error?.message || error) });
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

manager.prelaunchIfConfigured().then(
  () => {
    logEvent("prelaunch.ready", {
      enabled: manager.config.prelaunchBrowser
    });
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
  await manager.shutdown();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
