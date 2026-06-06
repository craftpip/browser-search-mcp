# Agents

This project is a Model Context Protocol (MCP) server that provides web search, page extraction, and screenshot capabilities using a real Chromium browser.

## Tool Contract

### web_search
- **Purpose**: Primary tool for broad web research across nearly any user request
- **Input**:
  - `query` (string) - single query OR
  - `queries` (string[]) - multiple variants
  - `limit` (number, default 5)
  - `engine` (`duckduckgo_api` | `bing_lp` | `mojeek_lp` | `google_ch` | `duckduckgo_ch`)
  - `engines` (string[])
- **Output**: `results[]` with `{ title, snippet, llmText, ref_id, link, url }`

### web_open_page
- **Purpose**: Open pages and return cleaned readable text
- **Input** (choose one mode):
  - `{ "url": "https://..." }`
  - `{ "urls": ["https://...", "https://..."] }`
  - `{ "ref_id": 1 }` - numeric ref from previous `web_search`
  - `{ "ref_ids": [1, 2, 3] }`
  - `maxChars` (number, default 8000)
- **Output**: Per-item success/error with SEO metadata

### web_page_screenshot
- **Purpose**: Capture rendered page appearance as images
- **Input**:
  - `{ "url": "https://..." }` or `{ "urls": [...] }`
  - `{ "ref_id": 1 }` or `{ "ref_ids": [1, 2] }
  - `format` (`png` | `jpeg`, default `png`)
  - `quality` (1-100 for JPEG)
  - `fullPage` (default `true`)
- **Output**: `screenshotBase64` with metadata

## Recommended Agent Flow

1. Call `web_search` with user intent
2. Pick best result refs from `results[].ref_id`
3. Call `web_open_page` with `ref_id` or `ref_ids`
4. Synthesize answer from extracted text

For visual verification, call `web_page_screenshot` with the same `ref_id`/`ref_ids`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROME_PATH` | `/usr/bin/chromium` | Path to Chromium executable |
| `HEADLESS` | `true` | Run browser headless |
| `BROWSER_OP_TIMEOUT_MS` | `60000` | Browser operation timeout |
| `SEARCH_ENGINES` | `duckduckgo_api,bing_lp,mojeek_lp,google_ch,duckduckgo_ch` | Search engines to use |
| `SEARCH_ROUTE_CIRCUIT_OPEN_MS` | `300000` | Per-route cooldown after failure |
| `PRELAUNCH_BROWSER` | `1` | Prelaunch browser on startup |
| `ENABLE_HTTP_MCP` | `0` | Enable Streamable HTTP transport |

## Development Commands

```bash
npm start          # Run MCP server over stdio
npm run test:mcporter  # Test MCP integration
```

## Key Notes

- Ref memory is process-local and resets when server restarts
- Prefer `ref_id`/`ref_ids` immediately after a search in the same session
- Sticky search windows are reused for performance
