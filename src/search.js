import { getBrowserManager } from "./browser.js";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const SUPPORTED_ENGINES = new Set(["bing", "duckduckgo", "google"]);
const ENGINE_PAGE_CONFIG = {
  duckduckgo: {
    homeUrl: "https://duckduckgo.com/",
    inputSelectors: ["input[name='q']", "input#searchbox_input", "input[data-testid='searchbox-input']"],
    resultSelectors: ["article[data-testid='result']", ".result", "#links"]
  },
  google: {
    homeUrl: "https://www.google.com/",
    inputSelectors: ["textarea[name='q']", "input[name='q']"],
    resultSelectors: ["#search", "#search .MjjYud", "#search .g"]
  },
  bing: {
    homeUrl: "https://www.bing.com/",
    inputSelectors: ["textarea[name='q']", "input[name='q']", "input#sb_form_q"],
    resultSelectors: ["#b_results", "#b_results li.b_algo"]
  }
};

function cleanWhitespace(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function normalizeQueryText(input) {
  let text = String(input || "").trim();
  if (!text) return "";

  const quotePairs = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
    ["‘", "’"]
  ];
  const quoteChars = new Set(["\"", "'", "`", "“", "”", "‘", "’"]);

  let changed = true;
  while (changed && text.length > 1) {
    changed = false;
    for (const [open, close] of quotePairs) {
      if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
        text = text.slice(open.length, text.length - close.length).trim();
        changed = true;
      }
    }
  }

  if (text.length > 1 && quoteChars.has(text[0]) && !quoteChars.has(text[text.length - 1])) {
    text = text.slice(1).trimStart();
  }

  return text;
}

function normalizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.includes("google.") && parsed.pathname === "/url") {
      const redirect = parsed.searchParams.get("q");
      if (redirect) return redirect;
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeEngines(engines, fallback) {
  const input = Array.isArray(engines) ? engines : [engines].filter(Boolean);
  const requested = input.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  const normalized = input
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => SUPPORTED_ENGINES.has(item));
  if (requested.length && !normalized.length) {
    throw new Error(
      `No valid engines requested. Supported engines: ${[...SUPPORTED_ENGINES].join(", ")}`
    );
  }
  return normalized.length ? [...new Set(normalized)] : fallback;
}

function buildLlmText(result) {
  return cleanWhitespace(`${result.title}\n${result.snippet}`);
}

function dedupeDirectAnswers(answers, maxItems = 10) {
  const byKey = new Map();

  for (const item of answers) {
    const text = cleanWhitespace(item?.text);
    if (!text) continue;

    const source = cleanWhitespace(item?.source || "answer").toLowerCase();
    const key = `${source}|${text.toLowerCase()}`;
    const queryVariants = Array.isArray(item?.queryVariants)
      ? item.queryVariants.map((q) => cleanWhitespace(q)).filter(Boolean)
      : [cleanWhitespace(item?.queryVariant)].filter(Boolean);

    if (!byKey.has(key)) {
      byKey.set(key, {
        source,
        text,
        url: cleanWhitespace(item?.url || ""),
        ...(queryVariants.length ? { queryVariants } : {})
      });
      continue;
    }

    if (queryVariants.length) {
      const existing = byKey.get(key);
      const merged = [...new Set([...(existing.queryVariants || []), ...queryVariants])];
      if (merged.length) {
        existing.queryVariants = merged;
      }
    }
  }

  return [...byKey.values()].slice(0, maxItems);
}

function cleanAndTruncateText(text, maxChars) {
  return cleanWhitespace(text).slice(0, maxChars);
}

const NON_CONTENT_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "header",
  "footer",
  "nav",
  "aside",
  ".cookie",
  ".cookies",
  "[class*='cookie']",
  "[id*='cookie']",
  "[class*='consent']",
  "[id*='consent']",
  "[class*='subscribe']",
  "[id*='subscribe']",
  "[class*='banner']",
  "[id*='banner']",
  "[role='dialog']"
];

const SEMANTIC_CONTENT_SELECTORS = [
  "main",
  "article",
  "[role='main']",
  "section",
  ".content",
  "#content",
  ".main",
  "#main"
];

const SEO_MAIN_NODE_SELECTORS = [
  ...new Set([
    ...SEMANTIC_CONTENT_SELECTORS,
    "body",
    "div[role='main']",
    ".article",
    ".article-body",
    ".post",
    ".post-content",
    "[data-component*='content']",
    "[data-testid*='content']",
    "[data-main-content]",
    "[data-testid*='article']",
    "[data-module*='article']"
  ])
];

const DEFAULT_HEADING_SELECTORS = ["h1", "h2", "h3", "h4"];
const MAX_SEO_CANDIDATES = 5;
const MAX_MAIN_TEXT_CHARS = 24000;
const MAX_MAIN_HTML_CHARS = 60000;

const WEATHER_KEYWORDS = [
  "weather",
  "forecast",
  "temperature",
  "humidity",
  "wind",
  "rain",
  "max",
  "min"
];

function uniqueLines(lines) {
  const seen = new Set();
  const output = [];
  for (const line of lines) {
    const normalized = cleanWhitespace(line).toLowerCase();
    if (!normalized) continue;
    if (normalized.length < 3) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(cleanWhitespace(line));
  }
  return output;
}

function toLines(text) {
  return String(text || "")
    .split(/\r?\n+/)
    .map((line) => cleanWhitespace(line))
    .filter(Boolean);
}

function isLikelyJunkLine(line) {
  const lower = line.toLowerCase();
  if (line.length < 20) return false;
  if (/(read more|see all maps|privacy policy|all rights reserved)/i.test(lower)) return true;
  if (/^[a-z]{2,4}\d{2}/i.test(lower)) return true;
  if (/^(night|am|pm|nnw|wnw|ssw|ene|w|nw|sw|ne|se)(\s|$)/i.test(lower)) return true;
  return false;
}

function scoreTextBlock(text) {
  const cleaned = cleanWhitespace(text);
  if (!cleaned) return -Infinity;

  const words = cleaned.split(/\s+/).length;
  const links = (cleaned.match(/https?:\/\//g) || []).length;
  const punctuation = (cleaned.match(/[\.!?]/g) || []).length;
  const keywordHits = WEATHER_KEYWORDS.reduce(
    (total, keyword) => total + (cleaned.toLowerCase().includes(keyword) ? 1 : 0),
    0
  );

  return words + punctuation * 2 + keywordHits * 8 - links * 5;
}

function collectCandidateBlocks(doc) {
  const candidates = [];

  for (const selector of SEMANTIC_CONTENT_SELECTORS) {
    const nodes = doc.querySelectorAll(selector);
    for (const node of nodes) {
      const text = cleanWhitespace(node.textContent || "");
      if (!text) continue;
      candidates.push({ text, score: scoreTextBlock(text) });
    }
  }

  if (!candidates.length && doc.body?.textContent) {
    const bodyText = cleanWhitespace(doc.body.textContent);
    candidates.push({ text: bodyText, score: scoreTextBlock(bodyText) });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function extractWeatherSummary(lines) {
  const weatherLines = lines.filter((line) => {
    const lower = line.toLowerCase();
    return WEATHER_KEYWORDS.some((keyword) => lower.includes(keyword));
  });

  if (!weatherLines.length) return null;

  const headline = weatherLines.find((line) => /forecast|weather/i.test(line)) || weatherLines[0];
  const today = weatherLines.find((line) => /today|1.?3 days|mostly|warm/i.test(line));
  const shortRange = weatherLines.find((line) => /4.?7 days|next week|10 day|7.?10 days/i.test(line));

  const summary = [headline, today, shortRange].filter(Boolean);
  const cleanedSummary = uniqueLines(summary);
  if (!cleanedSummary.length) return null;
  return cleanedSummary;
}

function buildCleanText(lines, maxChars) {
  const filtered = lines.filter((line) => !isLikelyJunkLine(line));
  const deduped = uniqueLines(filtered);
  return cleanAndTruncateText(deduped.join("\n"), maxChars);
}

function normalizeParagraphText(input) {
  const segments = String(input || "")
    .replace(/\r/g, "")
    .split(/\n/);
  const output = [];

  for (const raw of segments) {
    const line = raw.trim();
    if (!line) {
      if (output.length && output[output.length - 1] !== "") {
        output.push("");
      }
      continue;
    }
    output.push(line);
  }

  while (output.length && output[output.length - 1] === "") {
    output.pop();
  }

  return output.join("\n");
}

function safeTruncateText(input, maxChars) {
  const text = String(input || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function truncateParagraphText(input, maxChars) {
  return safeTruncateText(normalizeParagraphText(input), maxChars);
}

function sanitizeHtmlSnippet(input, maxChars = MAX_MAIN_HTML_CHARS) {
  const html = String(input || "");
  if (!html) return "";
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return safeTruncateText(stripped, maxChars);
}

function extractTextFromHtml({ html, url, maxChars, fallbackTitle }) {
  const safeHtml = typeof html === "string" ? html : "";
  const dom = new JSDOM(safeHtml || "<body></body>", { url });

  try {
    const doc = dom.window.document;
    doc.querySelectorAll(NON_CONTENT_SELECTORS.join(",")).forEach((node) => node.remove());

    let article = null;
    try {
      const reader = new Readability(dom.window.document);
      article = reader.parse();
    } catch {
      article = null;
    }

    if (article?.textContent?.trim()) {
      const articleLines = toLines(article.textContent);
      const weatherSummary = extractWeatherSummary(articleLines);
      const text = weatherSummary
        ? cleanAndTruncateText(weatherSummary.join("\n"), maxChars)
        : buildCleanText(articleLines, maxChars);

      return {
        title: cleanWhitespace(article.title || fallbackTitle || ""),
        url,
        text
      };
    }

    const candidates = collectCandidateBlocks(doc);
    const bestText = candidates[0]?.text || doc.body?.textContent || "";
    const lines = toLines(bestText);
    const weatherSummary = extractWeatherSummary(lines);

    return {
      title: cleanWhitespace(doc.title || fallbackTitle || ""),
      url,
      text: weatherSummary
        ? cleanAndTruncateText(weatherSummary.join("\n"), maxChars)
        : buildCleanText(lines, maxChars)
    };
  } finally {
    dom.window.close();
  }
}

async function captureSeoSnapshot(
  page,
  {
    textLimit = MAX_MAIN_TEXT_CHARS,
    htmlLimit = MAX_MAIN_HTML_CHARS,
    maxCandidates = MAX_SEO_CANDIDATES
  } = {}
) {
  try {
    const selectors = [...new Set(SEO_MAIN_NODE_SELECTORS)];
    const headingSelectors = [...new Set(DEFAULT_HEADING_SELECTORS)];
    if (!selectors.length) return null;

    return await page.evaluate(
      ({ selectors: rawSelectors, headingSelectors: rawHeadingSelectors, textLimit, htmlLimit, maxCandidates }) => {
        const selectorString = rawSelectors.join(",");
        const headingSelectorString = rawHeadingSelectors.length
          ? rawHeadingSelectors.join(",")
          : "h1,h2,h3";
        const documentHeight =
          document.body?.scrollHeight || document.documentElement?.scrollHeight || window.innerHeight || 0;

        const clamp = (value, limit) => {
          if (!value) return "";
          if (!Number.isFinite(limit) || limit <= 0) return String(value);
          const text = String(value);
          if (text.length <= limit) return text;
          if (limit <= 3) {
            return text.slice(0, limit);
          }
          return `${text.slice(0, limit - 3)}...`;
        };

        const normalizeText = (value) => {
          const segments = String(value || "")
            .replace(/\r/g, "")
            .split(/\n/);
          const output = [];
          for (const raw of segments) {
            const line = raw.trim();
            if (!line) {
              if (output.length && output[output.length - 1] !== "") {
                output.push("");
              }
              continue;
            }
            output.push(line);
          }
          while (output.length && output[output.length - 1] === "") {
            output.pop();
          }
          return output.join("\n");
        };

        const isProbablyVisible = (el) => {
          if (!el || typeof el.getBoundingClientRect !== "function") return false;
          const style = window.getComputedStyle(el);
          if (!style) return false;
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (Number(style.opacity) === 0) return false;
          const rect = el.getBoundingClientRect();
          if (!rect) return false;
          if (rect.width < 2 || rect.height < 2) return false;
          if (rect.bottom <= 0 || rect.right <= 0) return false;
          return true;
        };

        const pathFor = (node) => {
          const segments = [];
          let current = node;
          while (current && current !== document.body && segments.length < 8) {
            let segment = current.tagName ? current.tagName.toLowerCase() : "node";
            if (current.id) {
              segment += "#" + current.id;
            } else if (current.classList && current.classList.length) {
              const classParts = Array.from(current.classList)
                .slice(0, 2)
                .map((cls) => cls.replace(/\s+/g, "-"));
              if (classParts.length) {
                segment += "." + classParts.join(".");
              }
            }

            const parent = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
              if (siblings.length > 1) {
                const index = siblings.indexOf(current);
                if (index >= 0) {
                  segment += `:nth-of-type(${index + 1})`;
                }
              }
            }

            segments.unshift(segment);
            current = current.parentElement;
          }
          return segments.join(" > ");
        };

        const shouldSkipNode = (pathLower, roleAttr = "") => {
          if (!pathLower) return false;
          if (roleAttr && /(navigation|banner|contentinfo|complementary)/.test(roleAttr)) return true;
          return /(footer|nav|subscribe|cookie|legal|banner|header|menu|signin|login)/.test(pathLower);
        };

        const computeDepth = (node) => {
          let depth = 0;
          let current = node;
          while (current && current !== document.body && depth < 60) {
            depth += 1;
            current = current.parentElement;
          }
          return depth;
        };

        const headingNodes = Array.from(document.querySelectorAll(headingSelectorString))
          .map((node) => {
            const text = normalizeText(node.innerText || "");
            if (!text) return null;
            return {
              level: Number(node.tagName?.slice(1)) || null,
              text: clamp(text, 400),
              path: pathFor(node)
            };
          })
          .filter(Boolean)
          .slice(0, 50);

        const elements = selectorString ? Array.from(document.querySelectorAll(selectorString)) : [];
        const seen = new Set();
        const candidates = [];

        for (const el of elements) {
          if (!el || seen.has(el)) continue;
          seen.add(el);
          if (!isProbablyVisible(el)) continue;
          const text = normalizeText(el.innerText || "");
          if (text.length < 120) continue;
          const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
          const depth = computeDepth(el);
          const anchorTextLength = Array.from(el.querySelectorAll("a")).reduce((total, anchor) => {
            const anchorText = normalizeText(anchor.innerText || "");
            return total + anchorText.length;
          }, 0);
          const linkDensity = text.length ? anchorTextLength / text.length : 0;
          const headingWeight = el.querySelectorAll(headingSelectorString).length;
          const sizeScore = rect ? Math.min(2000, Math.max(0, (rect.width || 0) * (rect.height || 0) * 0.01)) : 0;
          const path = pathFor(el);
          const roleAttr = (el.getAttribute?.("role") || "").toLowerCase();
          const pathLower = path.toLowerCase();
          if (shouldSkipNode(pathLower, roleAttr)) continue;
          const rectTop = rect ? Math.max(0, rect.top || 0) : 0;
          const normalizedTop = documentHeight ? rectTop / documentHeight : 0;
          const viewportPenalty = rectTop > 4000 ? (rectTop - 4000) * 0.4 : 0;
          const bottomEdge = rectTop + (rect?.height || 0);
          const normalizedBottom = documentHeight ? bottomEdge / documentHeight : normalizedTop;
          const bottomPenalty = normalizedBottom > 0.9 ? (normalizedBottom - 0.9) * 1500 : 0;

          const score =
            text.length +
            headingWeight * 250 -
            linkDensity * 400 +
            Math.max(0, 300 - depth * 20) +
            sizeScore -
            viewportPenalty -
            bottomPenalty;

          candidates.push({
            tag: el.tagName ? el.tagName.toLowerCase() : "element",
            path,
            text: clamp(text, textLimit),
            html: clamp(el.innerHTML || "", htmlLimit),
            score: Math.round(score),
            depth,
            linkDensity,
            headingCount: headingWeight
          });
        }

        if (!candidates.length) {
          const fallbackText = normalizeText(document.body?.innerText || "");
          if (fallbackText.length) {
            candidates.push({
              tag: "body",
              path: "body",
              text: clamp(fallbackText, textLimit),
              html: clamp(document.body?.innerHTML || "", htmlLimit),
              score: Math.min(500, fallbackText.length),
              depth: 0,
              linkDensity: 0,
              headingCount: 0
            });
          }
        }

        candidates.sort((a, b) => b.score - a.score);

        const canonical =
          document.querySelector("link[rel='canonical']")?.href ||
          document.querySelector("link[rel='alternate'][hreflang='x-default']")?.href ||
          "";
        const metaDescription =
          document.querySelector("meta[name='description']")?.content ||
          document.querySelector("meta[property='og:description']")?.content ||
          "";
        const ogTitle = document.querySelector("meta[property='og:title']")?.content || "";

        return {
          title: document.title || ogTitle || "",
          canonicalUrl: canonical,
          metaDescription,
          headings: headingNodes,
          mainCandidates: candidates.slice(0, Math.max(1, Math.min(maxCandidates || 1, candidates.length)))
        };
      },
      {
        selectors,
        headingSelectors,
        textLimit,
        htmlLimit,
        maxCandidates: Math.max(1, maxCandidates || 1)
      }
    );
  } catch {
    return null;
  }
}

function buildSeoAnalysis({ snapshot, extracted, maxChars }) {
  if (!snapshot && !extracted) return null;

  const headings = Array.isArray(snapshot?.headings)
    ? snapshot.headings
        .map((item) => ({
          level: item.level,
          path: item.path,
          text: truncateParagraphText(item.text || "", 400)
        }))
        .filter((item) => Boolean(item.text))
    : [];

  const bestCandidate = snapshot?.mainCandidates?.[0];
  const fallbackText = extracted?.text || bestCandidate?.text || "";
  const mainContentText = truncateParagraphText(bestCandidate?.text || fallbackText, maxChars);
  const mainContentHtml = bestCandidate?.html
    ? sanitizeHtmlSnippet(bestCandidate.html, Math.max(maxChars * 4, MAX_MAIN_HTML_CHARS))
    : "";

  const candidates = Array.isArray(snapshot?.mainCandidates)
    ? snapshot.mainCandidates.map((candidate) => ({
        tag: candidate.tag,
        path: candidate.path,
        score: candidate.score,
        depth: candidate.depth,
        textSnippet: truncateParagraphText(candidate.text || "", Math.min(800, maxChars))
      }))
    : [];

  const normalizedTitle = cleanWhitespace(snapshot?.title || extracted?.title || "");
  const canonicalUrl = cleanWhitespace(snapshot?.canonicalUrl || "");
  const metaDescription = cleanWhitespace(snapshot?.metaDescription || "");

  return {
    title: normalizedTitle,
    canonicalUrl,
    metaDescription,
    headings,
    mainContentText,
    ...(mainContentHtml ? { mainContentHtml } : {}),
    ...(bestCandidate?.path ? { mainContentPath: bestCandidate.path } : {}),
    candidates
  };
}

function dedupeAndMergeResults(results, limitPerEngine) {
  const byEngineCount = new Map();
  const byUrl = new Map();

  for (const result of results) {
    const engineCount = byEngineCount.get(result.engine) || 0;
    if (engineCount >= limitPerEngine) continue;

    const url = normalizeUrl(result.url);
    if (!url) continue;

    byEngineCount.set(result.engine, engineCount + 1);

    const item = {
      title: cleanWhitespace(result.title),
      url,
      snippet: cleanWhitespace(result.snippet)
    };

    if (!byUrl.has(url)) {
      byUrl.set(url, {
        ...item,
        llmText: buildLlmText(item)
      });
      continue;
    }

    const existing = byUrl.get(url);
    if (!existing.snippet && item.snippet) {
      existing.snippet = item.snippet;
      existing.llmText = buildLlmText(existing);
    }
  }

  return [...byUrl.values()];
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

async function waitForAnySelector(page, selectors, timeout) {
  await Promise.any(selectors.map((selector) => page.waitForSelector(selector, { timeout })));

  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (handle) return handle;
  }

  throw new Error(`Could not resolve any selector: ${selectors.join(", ")}`);
}

async function submitSearchFromHomepage({ page, query, engine, config }) {
  const engineConfig = ENGINE_PAGE_CONFIG[engine];

  await page.goto(engineConfig.homeUrl, {
    waitUntil: "domcontentloaded",
    timeout: config.browserOpTimeoutMs
  });

  const input = await waitForAnySelector(page, engineConfig.inputSelectors, config.browserOpTimeoutMs);
  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await input.type(query, { delay: config.humanTypingDelay });

  const navPromise = page
    .waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: config.browserOpTimeoutMs
    })
    .catch(() => null);

  await input.press("Enter");
  await navPromise;
  await waitForAnySelector(page, engineConfig.resultSelectors, config.browserOpTimeoutMs);
}

async function runSearchEngine({ manager, query, engine, config }) {
  const page = await manager.acquireSearchWindow(engine, {
    startupUrl: ENGINE_PAGE_CONFIG[engine].homeUrl,
    waitUntil: "domcontentloaded"
  });

  try {
    await submitSearchFromHomepage({ page, query, engine, config });

    if (engine === "duckduckgo") {
      const payload = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("article[data-testid='result'], .result"));
        const results = rows.map((row) => {
          const anchor = row.querySelector("a[data-testid='result-title-a'], h2 a, a.result__a");
          const snippetEl = row.querySelector(
            "[data-result='snippet'], .result__snippet, .result-snippet"
          );
          return {
            title: anchor?.textContent || "",
            url: anchor?.href || "",
            snippet: snippetEl?.textContent || ""
          };
        });

        const answerNodes = [
          ...document.querySelectorAll("[data-testid='instant-answer']"),
          ...document.querySelectorAll(".zci__answer, .zci__result, .module__body")
        ];
        const directAnswers = answerNodes.map((node) => ({
          source: "instant_answer",
          text: node?.textContent || ""
        }));

        return { results, directAnswers };
      });

      return {
        results: payload.results.map((item) => ({ ...item, engine })),
        directAnswers: dedupeDirectAnswers(
          (payload.directAnswers || []).map((item) => ({ ...item, engine, url: page.url() }))
        )
      };
    }

    if (engine === "google") {
      const payload = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("#search .MjjYud, #search .g"));
        const results = rows.map((row) => {
          const anchor = row.querySelector("a:has(h3)") || row.querySelector("h3")?.closest("a");
          const heading = row.querySelector("h3");
          const snippetEl = row.querySelector(".VwiC3b, [data-sncf], div[data-content-feature='1']");

          return {
            title: heading?.textContent || "",
            url: anchor?.href || "",
            snippet: snippetEl?.textContent || ""
          };
        });

        const answerNodes = [
          ...document.querySelectorAll("#search .kno-rdesc span, #search [data-attrid='wa:/description']"),
          ...document.querySelectorAll("#search .hgKElc, #search .IZ6rdc, #search .V3FYCf")
        ];
        const directAnswers = answerNodes.map((node) => ({
          source: "direct_answer",
          text: node?.textContent || ""
        }));

        return { results, directAnswers };
      });

      return {
        results: payload.results.map((item) => ({ ...item, engine })),
        directAnswers: dedupeDirectAnswers(
          (payload.directAnswers || []).map((item) => ({ ...item, engine, url: page.url() }))
        )
      };
    }

    const payload = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("#b_results li.b_algo"));
      const results = rows.map((row) => {
        const anchor = row.querySelector("h2 a") || row.querySelector("a");
        const snippetEl =
          row.querySelector(".b_caption p") || row.querySelector(".b_snippet") || row.querySelector("p");

        return {
          title: anchor?.textContent || "",
          url: anchor?.href || "",
          snippet: snippetEl?.textContent || ""
        };
      });

      const answerNodes = [
        ...document.querySelectorAll(".b_ans .b_focusTextLarge, .b_ans .b_paractl, .b_ans .b_snippet"),
        ...document.querySelectorAll("#b_results .b_entityTP .b_snippet")
      ];
      const directAnswers = answerNodes.map((node) => ({
        source: "direct_answer",
        text: node?.textContent || ""
      }));

      return { results, directAnswers };
    });

    return {
      results: payload.results.map((item) => ({ ...item, engine })),
      directAnswers: dedupeDirectAnswers(
        (payload.directAnswers || []).map((item) => ({ ...item, engine, url: page.url() }))
      )
    };
  } finally {
    await manager.releaseSearchWindow(engine, page);
  }
}

export async function browserSearch({ query, queries, limit = 5, engines }) {
  const manager = await getBrowserManager();
  const selectedEngines = normalizeEngines(engines, manager.config.searchEngines);

  const queryList = [];
  if (typeof query === "string") {
    const normalizedQuery = normalizeQueryText(query);
    if (normalizedQuery) {
      queryList.push(normalizedQuery);
    }
  }

  if (Array.isArray(queries)) {
    for (const item of queries) {
      if (typeof item === "string") {
        const normalizedQuery = normalizeQueryText(item);
        if (normalizedQuery) {
          queryList.push(normalizedQuery);
        }
      }
    }
  }

  const uniqueQueries = [...new Set(queryList)];
  if (!uniqueQueries.length) {
    throw new Error("Missing query/queries: provide at least one search query");
  }

  const perQueryTasks = uniqueQueries.map(async (singleQuery) => {
    const settled = await mapWithConcurrency(
      selectedEngines,
      selectedEngines.length,
      async (engine) => {
        try {
          const value = await manager.withPageSlot(() =>
            runSearchEngine({
              manager,
              query: singleQuery,
              engine,
              config: manager.config
            })
          );
          return { status: "fulfilled", value };
        } catch (reason) {
          return { status: "rejected", reason };
        }
      }
    );

    const allResults = [];
    const allDirectAnswers = [];
    const errors = [];

    for (let index = 0; index < settled.length; index += 1) {
      const entry = settled[index];
      if (entry.status === "fulfilled") {
        allResults.push(...(entry.value.results || []));
        allDirectAnswers.push(...(entry.value.directAnswers || []));
      } else {
        errors.push({
          error: String(entry.reason?.message || entry.reason)
        });
      }
    }

    const results = dedupeAndMergeResults(allResults, limit);
    const directAnswers = dedupeDirectAnswers(allDirectAnswers);
    return {
      query: singleQuery,
      resultCount: results.length,
      results,
      directAnswerCount: directAnswers.length,
      directAnswers,
      errors
    };
  });

  const queryResults = await Promise.all(perQueryTasks);

  if (queryResults.length === 1) {
    return {
      query: queryResults[0].query,
      resultCount: queryResults[0].resultCount,
      results: queryResults[0].results,
      directAnswerCount: queryResults[0].directAnswerCount,
      directAnswers: queryResults[0].directAnswers,
      errors: queryResults[0].errors
    };
  }

  const combinedByUrl = new Map();
  const combinedDirectAnswers = [];
  for (const item of queryResults) {
    combinedDirectAnswers.push(
      ...(item.directAnswers || []).map((answer) => ({
        ...answer,
        queryVariant: item.query
      }))
    );

    for (const result of item.results) {
      if (!combinedByUrl.has(result.url)) {
        combinedByUrl.set(result.url, {
          ...result,
          queryVariants: [item.query]
        });
        continue;
      }

      const existing = combinedByUrl.get(result.url);
      if (!existing.queryVariants.includes(item.query)) {
        existing.queryVariants.push(item.query);
      }
    }
  }

  return {
    queries: uniqueQueries,
    queryCount: uniqueQueries.length,
    totalResultCount: [...combinedByUrl.values()].length,
    results: [...combinedByUrl.values()],
    totalDirectAnswerCount: dedupeDirectAnswers(combinedDirectAnswers).length,
    directAnswers: dedupeDirectAnswers(combinedDirectAnswers),
    queryResults
  };
}

export async function browserOpenAndExtract({ url, maxChars = 8000, includeSeoAnalysis = true }) {
  const manager = await getBrowserManager();

  return manager.withPageSlot(async () => {
    const page = await manager.newPage();

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: manager.config.browserOpTimeoutMs
      });

      await page
        .waitForFunction(
          () => {
            const container =
              document.querySelector("main, article, [role='main'], .content, #content") || document.body;
            if (!container) return false;
            const text = container.innerText || "";
            return text.replace(/\s+/g, " ").trim().length > 200;
          },
          { timeout: Math.min(10000, manager.config.browserOpTimeoutMs) }
        )
        .catch(() => null);

      const seoSnapshot =
        includeSeoAnalysis === false
          ? null
          : await captureSeoSnapshot(page, {
              textLimit: Math.min(MAX_MAIN_TEXT_CHARS, Math.max(maxChars * 3, 4000)),
              htmlLimit: Math.min(Math.max(MAX_MAIN_HTML_CHARS, maxChars * 6), 120000),
              maxCandidates: MAX_SEO_CANDIDATES
            });

      const [html, resolvedUrl, pageTitle] = await Promise.all([
        page.content(),
        Promise.resolve(page.url()),
        page.title()
      ]);

      const extracted = extractTextFromHtml({
        html,
        url: resolvedUrl,
        maxChars,
        fallbackTitle: pageTitle
      });

      const seoAnalysis =
        includeSeoAnalysis === false
          ? null
          : buildSeoAnalysis({ snapshot: seoSnapshot, extracted, maxChars });

      const selectedText =
        seoAnalysis?.mainContentText &&
        seoAnalysis.mainContentText.length > (extracted?.text?.length || 0)
          ? seoAnalysis.mainContentText
          : extracted.text;

      return {
        ...extracted,
        text: selectedText || extracted.text || "",
        ...(seoAnalysis ? { seo: seoAnalysis } : {})
      };
    } finally {
      await page.close();
    }
  });
}

export async function browserCaptureScreenshot({
  url,
  format = "png",
  fullPage = true,
  quality
}) {
  const manager = await getBrowserManager();
  const normalizedFormat = format === "jpeg" ? "jpeg" : "png";
  const normalizedQuality =
    normalizedFormat === "jpeg" && Number.isFinite(quality)
      ? Math.max(1, Math.min(100, Math.floor(quality)))
      : undefined;

  return manager.withPageSlot(async () => {
    const page = await manager.newPage();

    try {
      await page.goto(url, {
        waitUntil: manager.config.navWaitUntil,
        timeout: manager.config.browserOpTimeoutMs
      });

      await page
        .waitForFunction(
          () => {
            const container =
              document.querySelector("main, article, [role='main'], .content, #content") || document.body;
            if (!container) return false;
            const text = container.innerText || "";
            return text.replace(/\s+/g, " ").trim().length > 200;
          },
          { timeout: Math.min(10000, manager.config.browserOpTimeoutMs) }
        )
        .catch(() => null);

      const dimensions = await page.evaluate(() => {
        const docEl = document.documentElement;
        const body = document.body;
        const viewportWidth = window.innerWidth || docEl?.clientWidth || 0;
        const viewportHeight = window.innerHeight || docEl?.clientHeight || 0;
        const fullWidth = Math.max(docEl?.scrollWidth || 0, body?.scrollWidth || 0, viewportWidth);
        const fullHeight = Math.max(docEl?.scrollHeight || 0, body?.scrollHeight || 0, viewportHeight);
        return {
          viewportWidth,
          viewportHeight,
          fullWidth,
          fullHeight
        };
      });

      const screenshot = await page.screenshot({
        type: normalizedFormat,
        encoding: "base64",
        fullPage: fullPage !== false,
        ...(normalizedFormat === "jpeg" && normalizedQuality ? { quality: normalizedQuality } : {})
      });

      const [resolvedUrl, pageTitle] = await Promise.all([Promise.resolve(page.url()), page.title()]);

      return {
        url: resolvedUrl,
        title: pageTitle,
        format: normalizedFormat,
        contentType: normalizedFormat === "jpeg" ? "image/jpeg" : "image/png",
        sizeBytes: Buffer.byteLength(screenshot, "base64"),
        captureTimestamp: new Date().toISOString(),
        dimensions,
        screenshotBase64: screenshot
      };
    } finally {
      await page.close();
    }
  });
}
