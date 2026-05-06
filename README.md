# Browser Search MCP Server

MCP server that drives a real Chromium browser with Puppeteer for:

- web search (`web_search`)
- page extraction (`web_open_page`)
- page screenshots (`web_page_screenshot`)

It supports persistent Chromium profiles, robust profile lock recovery, and Docker with optional VNC/noVNC for interactive browser inspection.

The server can run MCP over stdio, Streamable HTTP (`/mcp`), or both at the same time.

## Features

- Shared browser manager (single Chromium instance reused across tool calls)
- Prelaunch mode for headful browser startup (ready right after container boot)
- Auto-recreate when browser disconnects
- Graceful shutdown on `SIGINT` / `SIGTERM`
- Persistent profile support via `CHROME_USER_DATA_DIR` + `CHROME_PROFILE_DIR`
- Profile lock recovery flow:
  1. normal launch
  2. remove stale lock files and retry
  3. clone profile to temp dir and launch there
- Parallel multi-engine search for a single query
- Article-aware extraction using Mozilla Readability with DOM cleanup fallback
- Tree-aware SEO snapshot that captures headings, canonical URLs, and main content HTML/text
- Configurable timeout, navigation wait strategy, and search engine list

## Project structure

- `src/config.js` - environment and runtime config
- `src/browser.js` - shared browser lifecycle and lock recovery
- `src/search.js` - search and extraction logic
- `src/mcp-server.js` - MCP stdio server and tool handlers
- `docker/entrypoint.sh` - VNC/noVNC bootstrap
- `Dockerfile` - container image for Chromium + MCP server
- `docker-compose.yml` - local orchestration with persistent profile volume

## Local install and run

Requirements:

- Node.js 20+
- Chromium installed locally (or set `CHROME_PATH`)

Install:

```bash
npm install
```

Run server over stdio:

```bash
npm start
```

## MCP client integration

Example MCP client config (stdio) using this project directory:

```json
{
  "mcpServers": {
    "browser-search": {
      "command": "node",
      "args": ["/absolute/path/to/browser-search-mcp/src/mcp-server.js"],
      "env": {
        "HEADLESS": "false",
        "CHROME_USER_DATA_DIR": "/tmp/chrome-mcp-profile",
        "CHROME_PROFILE_DIR": "Default",
        "PRELAUNCH_BROWSER": "1",
        "SEARCH_ENGINES": "bing,duckduckgo,google",
        "BROWSER_OP_TIMEOUT_MS": "60000",
        "NAV_WAIT_UNTIL": "domcontentloaded"
      }
    }
  }
}
```

For Streamable HTTP transport, enable `ENABLE_HTTP_MCP=1` and connect the client to:

- `http://<host>:<MCP_API_PORT>/mcp`

You can run both transports together by keeping `ENABLE_STDIO_MCP=1` and setting `ENABLE_HTTP_MCP=1`.

Tools exposed:

- `web_search` input: `{ query?, queries?, limit?, engines?, engine? }`
- `web_open_page` input: `{ url? | urls? | ref_id? | ref_ids?, maxChars? }`
- `web_page_screenshot` input: `{ url? | urls? | ref_id? | ref_ids?, format?, quality?, fullPage? }`

`web_search` labels each result link with a numeric reference like `[1]` and truncates displayed links to 50 characters.
`web_open_page` can open by direct `url`/`urls` or by `ref_id`/`ref_ids` from previous `web_search` results.

## Agent Inference Guide

Use this section as the tool contract for LLM/agent planning and calling.

`web_search`
- Purpose: primary tool for broad web research across nearly any user request.
- Use cases: fact lookup, documentation discovery, tutorials, comparisons, current events, and general information gathering.
- Input:
  - `query` string (single query) OR `queries` string[] (multiple variants)
  - optional `limit` number (default `5`)
  - optional `engine` (`bing` | `duckduckgo` | `google`)
  - optional `engines` array of engines
- Output highlights:
  - `results[]` contains `title`, `snippet`, `llmText`
  - `results[].ref_id` is a numeric handle for follow-up page opens
  - `results[].link` and `results[].url` are display-safe (`[n]` + truncated link)

`web_open_page`
- Purpose: open one or more pages and return cleaned readable text for downstream reasoning.
- Use cases: summarization, extraction, question answering, and synthesis from full page content.
- Input (choose one mode):
  - single URL: `{ "url": "https://..." }`
  - multiple URLs: `{ "urls": ["https://...", "https://..."] }`
  - single ref from `web_search`: `{ "ref_id": 1 }`
  - multiple refs: `{ "ref_ids": [1, 2, 3] }`
  - optional `maxChars` number (default `8000`)
- Behavior:
  - when `urls`/`ref_ids` are provided, opens in parallel up to `OPEN_PAGE_MAX_PARALLEL`
  - returns per-item success/error for multi-open calls
  - response now includes `seo`, a tree-aware snapshot with:
    - `title`, `canonicalUrl`, `metaDescription`
    - `headings[]` with level + DOM path information
    - `mainContentText` (preserves paragraphs) and `mainContentHtml`
    - `candidates[]` showing the top-scoring semantic nodes considered for the main body
  - the `text` field automatically prefers `seo.mainContentText` when it contains more on-page content than the Readability summary

`web_page_screenshot`
- Purpose: capture the rendered appearance of one or more pages as full-page images for visual inspection or archival.
- Use cases: UI verification, citing page layout, sharing what the model saw, or checking visual elements that do not translate well to text extraction.
- Input (choose one mode):
  - `{ "url": "https://..." }`
  - `{ "urls": ["https://...", "https://..."] }`
  - `{ "ref_id": 1 }` or `{ "ref_ids": [1, 2] }` from the latest `web_search`
  - optional `format` (`png` | `jpeg`, default `png`)
  - optional `quality` (1-100, JPEG only)
  - optional `fullPage` (default `true`)
- Behavior:
  - navigates with the same browser profile as other tools, waits for main content to stabilize, then captures `screenshotBase64`
  - returns metadata including `title`, `url`, `format`, `contentType`, byte size, capture timestamp, and viewport/full-page dimensions
  - supports multi-target calls with per-item success/error entries similar to `web_open_page`

Recommended agent flow
1. Call `web_search` with user intent.
2. Pick best result refs from `results[].ref_id`.
3. Call `web_open_page` with `ref_id` or `ref_ids`.
4. Synthesize answer from extracted text.

Need to show what the agent saw? Call `web_page_screenshot` with the same `ref_id`/`ref_ids` to capture the rendered page state as an image.

Notes for agents
- Ref memory is process-local and resets when server restarts.
- Prefer `ref_id`/`ref_ids` immediately after a search in the same session.

`web_search` runs all selected engines in parallel and returns an LLM-friendly payload:

- `query`
- `resultCount`
- `results[]` with `{ title, url, snippet, llmText }`
- `directAnswerCount`
- `directAnswers[]` with `{ source, text, url }`
- `errors[]` with `{ error }` (if any)

For multiple phrasings of the same intent, pass `queries` (array of strings). The server runs each query across selected engines and returns both per-query and combined results, including aggregated `directAnswers`.

## Docker build and run

Build image:

```bash
docker build -t browser-search-mcp .
```

Run container in service mode (for VNC and HTTP helper endpoints):

```bash
docker run -d --name browser-search-mcp \
  -e ENABLE_VNC=1 \
  -e HEADLESS=false \
  -p 5901:5900 \
  -p 7901:7900 \
  -p 3000:3000 \
  -v chrome_profile_data:/data/chrome \
  browser-search-mcp
```

For MCP stdio clients that spawn a new command often (for example one-shot CLI calls), use a landing script that reuses one Docker container:

- Linux/macOS command: `scripts/mcp-stdio-docker.sh`
- Windows command: `scripts\\mcp-stdio-docker.bat`

What this does:

- creates one named container (`browser-search-mcp-landing`) if missing
- starts it if stopped
- runs `node src/mcp-server.js` via `docker exec -i` for stdio transport
- keeps the same Chrome profile volume mounted across calls

Example MCP client config using the landing script:

```json
{
  "mcpServers": {
    "web-search": {
      "command": "C:\\absolute\\path\\to\\browser-search-mcp\\scripts\\mcp-stdio-docker.bat"
    }
  }
}
```

Important: stdio transport is process-scoped, so each new client process still starts a new MCP stdio session. The landing script prevents extra Docker containers and preserves browser profile state.

### Using docker-compose

```bash
cp .env.example .env
docker compose up --build
```

The compose file includes:

- named volume mounted at `/data/chrome`
- `HEADLESS`, `ENABLE_VNC`, `CHROME_USER_DATA_DIR`, `CHROME_PROFILE_DIR`, `VNC_PORT`, `NOVNC_PORT`
- noVNC host mapping `7901:7900`

## noVNC access

When `ENABLE_VNC=1`, open:

- `http://localhost:7900/vnc.html` (direct default mapping)
- `http://localhost:7901/vnc.html` (alternate mapping)

You can observe/interact with the same Chromium session used by MCP tools.

## Import local Chrome profile into container

To clone your local Chrome/Chromium user data dir into the running container:

```bash
scripts/clone-chrome-userdir.sh --source "/path/to/your/chrome-user-data-dir" --wipe
```

Examples for common source paths:

- Linux Chromium: `~/.config/chromium`
- Linux Chrome: `~/.config/google-chrome`
- macOS Chrome: `~/Library/Application Support/Google/Chrome`

After import, restart the service:

```bash
docker compose restart
```

## Environment variables

- `CHROME_PATH` (default: `/usr/bin/chromium`)
- `CHROME_USER_DATA_DIR` (default: `/data/chrome`)
- `CHROME_PROFILE_DIR` (default: `Default`)
- `HEADLESS` (default: `true` unless `DISPLAY` exists)
- `BROWSER_OP_TIMEOUT_MS` (default: `60000`)
- `ENABLE_HANG_RESTART` (default: `0`; when `1`, top-level browser operations that exceed hang timeout force process exit for container restart)
- `HANG_RESTART_TIMEOUT_MS` (default: `120000`; max duration before forced exit when hang restart is enabled)
- `NAV_WAIT_UNTIL` (default: `domcontentloaded`; valid: `load`, `domcontentloaded`, `networkidle0`, `networkidle2`)
- `SEARCH_ENGINES` (default: `bing,duckduckgo,google`)
- `PRELAUNCH_BROWSER` (default: `1`; set `0` to disable prelaunch)
- `STARTUP_URL` (default: `about:blank`; opened at prelaunch)
- `ENABLE_VNC` (default: `0`, set `1` to enable Xvfb + VNC + noVNC)
- `VNC_PORT` (default: `5900`)
- `NOVNC_PORT` (default: `7900`)
- `ENABLE_HTTP_HEALTH` (default: `0`)
- `MCP_API_PORT` (default: `3000`)
- `MCP_API_HOST` (default: `http://localhost`)
- `ENABLE_SCREENSHOT_DOWNLOAD_LINK` (default: `0`)
- `ENABLE_SCREENSHOT_PATH` (default: empty, path where screenshots are stored)
- `ENABLE_STDIO_MCP` (default: `1`; stdio transport)
- `ENABLE_HTTP_MCP` (default: `0`; Streamable HTTP transport on `/mcp`)
- `USE_STICKY_SEARCH_WINDOWS` (default: `1`; reuse per-engine search windows)
- `STICKY_SEARCH_WINDOW_LIMIT` (default: `10`; max number of sticky search windows kept open)
- `SEARCH_ENGINE_MAX_PARALLEL_TABS` (default: `10`; max engines processed concurrently)
- `SEARCH_ENGINE_PER_ENGINE_CONCURRENCY` (default: `10`; max concurrent tasks per engine across requests)
- `OPEN_PAGE_MAX_PARALLEL` (default: `6`; max URLs opened concurrently per `web_open_page`/`web_page_screenshot`/`/extract` call)
- `MAX_CONCURRENT_PAGE_OPS` (default: `30`; global page-op budget shared by search and extract)

Notes:

- Sticky search windows are reused opportunistically. If a sticky window for an engine is busy, search falls back to a non-sticky window for that request.
- `STICKY_SEARCH_WINDOW_LIMIT` limits only the sticky pool; total Chromium windows can be higher under high parallel load.

## Troubleshooting

### Profile lock recovery

If Chromium reports profile lock/in-use errors, the server automatically:

1. retries after deleting stale lock files (`SingletonLock`, `SingletonCookie`, `SingletonSocket`)
2. if still locked, clones profile to a temp dir, mirrors `CHROME_PROFILE_DIR` into `Default`, and launches `Default`

### Browser launch failures

- Verify Chromium exists at `CHROME_PATH`
- In Docker, keep `CHROME_PATH=/usr/bin/chromium`
- For sandbox-related failures in restrictive environments, default launch args already include `--no-sandbox` and `--disable-setuid-sandbox`

### Timeout tuning

- Increase `BROWSER_OP_TIMEOUT_MS` for slow pages (e.g. `120000`)
- Change `NAV_WAIT_UNTIL` to `domcontentloaded` for dynamic pages that never reach `networkidle2`
- For self-healing in Docker, set `ENABLE_HANG_RESTART=1`; if a top-level browser operation hangs longer than `HANG_RESTART_TIMEOUT_MS`, the process exits and Docker restart policy brings it back

### Keeping sessions logged in

- Run with `HEADLESS=false`, `ENABLE_VNC=1`, and persistent `/data/chrome` volume
- Login once through noVNC and future MCP requests reuse the same Chromium profile/session
