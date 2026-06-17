# Browser Search MCP Server

Browser Search MCP gives your MCP client a real browser for:

- web search
- readable page extraction
- page screenshots

It is built for HTTP MCP first, which makes it easy to run once and connect many times. If your client needs to launch a local process, stdio is supported too.

## What Makes It Nice To Use

- Real browser-backed search instead of a thin scraper
- Multiple search engines and multiple browser/backend routes
- Route-level circuit breakers so one failing route does not poison every request
- A strong `web_open_page` tool that returns clean, readable content
- A screenshot tool that can return base64, a local file path, or a download link
- Persistent browser sessions and profiles
- Optional VNC/noVNC access for interactive debugging

## Highlights

### Multi-engine search with route circuit breakers

This project is built to keep working even when one search route gets flaky.

- It supports multiple engines, including browser-backed and HTTP-backed routes
- It tracks route health separately
- When a route fails, it is temporarily opened in a circuit-breaker state instead of being hammered over and over
- Healthy routes can keep serving requests while unhealthy routes cool down
- Route health is visible from the `/health` endpoint

That makes the server much nicer for real use, especially in long-running HTTP deployments.

### Multiple search options inside the engine pool

This project does not depend on just one search path.

Depending on configuration, it can use a mix of:

- `duckduckgo_api`
- `bing_lp`
- `mojeek_lp`
- `google_ch`
- `duckduckgo_ch`
- and additional supported routes such as `bing_cb`, `duckduckgo_cb`, `google_cb`, and `google_lp`

That gives you flexibility when tuning for speed, resilience, compatibility, or anti-bot behavior.

### `web_open_page` is built for readable extraction

The open-page tool is one of the strongest parts of the project.

It does more than dump raw HTML. The extraction flow combines several methods:

- page navigation plus content settling, so extraction waits for meaningful content to appear
- DOM cleanup to remove noise like scripts, styles, popups, cookie banners, and obvious non-content areas
- Mozilla Readability for article-style extraction when possible
- a fallback semantic candidate scoring system that scores likely main-content blocks using things like text length, link density, heading density, depth, size, and position on the page
- SEO-aware snapshotting that captures headings, canonical URL, meta description, and the best main-content candidates

The final text prefers the richer main-content extraction when it beats the simpler article extraction.

So the output is usually much closer to what a person would want to read, not just what the DOM happened to contain.

### `web_page_screenshot` is designed for real LLM workflows

The screenshot tool started with base64 output, which is still supported, but large base64 blobs can waste tokens.

So the tool now supports better output modes too:

- base64 mode: useful when inline image data is acceptable
- path mode: the server stores the screenshot and returns a file path instead of base64
- link mode: the server stores the screenshot and returns a download URL instead of base64

Path mode is handy when the caller is on the same machine and can read the file directly.

Link mode is handy when the caller is remote and needs an HTTP URL to fetch the image.

You can enable these behaviors with:

- `ENABLE_SCREENSHOT_PATH`
- `ENABLE_SCREENSHOT_DOWNLOAD_LINK`

When either storage mode is enabled, the tool writes the screenshot to disk and avoids sending the full base64 payload back in the normal response.

### Lots of controls when you need them

The server is easy to start, but it also exposes a lot of tuning knobs for real-world use:

- browser backend selection
- engine selection and fallback behavior
- timeouts and navigation strategy
- browser profile persistence
- HTTP vs stdio transport
- screenshot storage behavior
- VNC/noVNC debugging
- concurrency and page operation limits

## Start Here

If you just want this working quickly, use the HTTP server setup below.

You will:

1. start the server with Docker
2. verify the health endpoint
3. point your MCP client at `http://127.0.0.1:3000/mcp`

## Recommended Setup: HTTP MCP Server

This is the best setup for most users.

### Requirements

- Docker
- Docker Compose

### Quick Start

1. Clone the repo:

```bash
git clone https://github.com/craftpip/browser-search-mcp.git
cd browser-search-mcp
```

2. Copy the example config:

```bash
cp .env.example .env
```

3. Start the server:

```bash
docker compose up --build -d
```

### Check That It Works

Run:

```bash
curl -s http://127.0.0.1:3000/health
```

You should see a JSON response with `"ok": true`.

### Connect Your MCP Client

Use this MCP endpoint:

```text
http://127.0.0.1:3000/mcp
```

If your client is on a different machine, replace `127.0.0.1` with the server IP or hostname.

### Example HTTP MCP Config

Different clients use different config formats, but the important value is the MCP URL:

```json
{
  "mcpServers": {
    "browser-search": {
      "transport": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

## Alternative Setup: stdio

Use stdio when your MCP client wants to launch a local command directly.

### Local stdio with Node.js

Requirements:

- Node.js 20+
- Chromium installed locally, or `CHROME_PATH` set to a valid browser binary

Install dependencies:

```bash
npm install
```

Run the server:

```bash
npm start
```

Example client config:

```json
{
  "mcpServers": {
    "browser-search": {
      "command": "node",
      "args": ["/absolute/path/to/browser-search-mcp/src/mcp-server.js"]
    }
  }
}
```

### stdio Backed by Docker

If your MCP client spawns lots of short-lived stdio sessions, use the landing script so the Docker container and browser profile can be reused.

- Linux/macOS: `scripts/mcp-stdio-docker.sh`
- Windows: `scripts\mcp-stdio-docker.bat`

Example client config:

```json
{
  "mcpServers": {
    "browser-search": {
      "command": "/absolute/path/to/browser-search-mcp/scripts/mcp-stdio-docker.sh"
    }
  }
}
```

## MCP Tools

This server exposes three tools.

### `web_search`

Search the web with one or more browser-backed engines.

This tool is designed to work across a pool of engines and routes rather than relying on a single fragile path.

Example input:

```json
{ "query": "latest MCP news", "limit": 5 }
```

Also supports:

- `queries`
- `engine`
- `engines`

### `web_open_page`

Open a page and return cleaned readable text.

Under the hood it uses DOM cleanup, Mozilla Readability, and a semantic main-content scoring fallback so the result is usually much cleaner than raw page text.

Example input:

```json
{ "url": "https://example.com", "maxChars": 8000 }
```

Also supports:

- `urls`
- `ref_id`
- `ref_ids`

### `web_page_screenshot`

Capture a rendered screenshot of a page.

By default the tool can return base64 image data. If screenshot storage is enabled, it can instead return a local file path, a download link, or both, which is much friendlier for LLM workflows.

Example input:

```json
{ "url": "https://example.com", "format": "png", "fullPage": true }
```

Also supports:

- `urls`
- `ref_id`
- `ref_ids`

## Main Configuration

The most important environment variables are:

- `ENABLE_HTTP_MCP`: enable HTTP MCP on `/mcp`
- `ENABLE_STDIO_MCP`: enable stdio transport
- `MCP_API_PORT`: HTTP server port, default `3000`
- `HEADLESS`: run browser headless or with UI
- `CHROME_PATH`: Chromium path for local installs
- `CHROME_USER_DATA_DIR`: persistent browser profile directory
- `CHROME_PROFILE_DIR`: Chrome profile subdirectory, default `Default`
- `PRELAUNCH_BROWSER`: prelaunch browser at startup
- `BROWSER_OP_TIMEOUT_MS`: browser operation timeout in milliseconds
- `SEARCH_ENGINES`: comma-separated engine list
- `ENABLE_VNC`: enable VNC and noVNC in Docker

See `.env.example` for the full list.

## Docker Notes

The included `docker-compose.yml` is the easiest supported deployment path.

It gives you:

- HTTP MCP on port `3000`
- `/health` for quick checks
- persistent browser profile storage
- optional VNC and noVNC access

Stop the service:

```bash
docker compose down
```

Rebuild after changes:

```bash
docker compose up --build -d
```

## noVNC Access

When `ENABLE_VNC=1`, open one of these in your browser:

- `http://127.0.0.1:7900/vnc.html`
- `http://127.0.0.1:7901/vnc.html`

This lets you watch or interact with the same browser session used by the MCP tools.

## Import a Local Chrome Profile into Docker

To clone an existing local Chrome or Chromium user data directory into the container volume:

```bash
scripts/clone-chrome-userdir.sh --source "/path/to/your/chrome-user-data-dir" --wipe
```

Then restart the service:

```bash
docker compose restart
```

## Troubleshooting

### `/health` does not respond

- Check that the container is running: `docker compose ps`
- Check logs: `docker compose logs`
- Make sure port `3000` is free

### Browser launch fails

- Verify Chromium exists at `CHROME_PATH` for local installs
- In Docker, keep `CHROME_PATH=/usr/bin/chromium`
- In restrictive environments, the default launch args already include no-sandbox flags

### Search requests fail sometimes

- Check `/health` for route circuit breaker status
- Increase `BROWSER_OP_TIMEOUT_MS` if the environment is slow
- Verify the container has outbound internet access

### A page never settles

- Use `NAV_WAIT_UNTIL=domcontentloaded`
- Increase `BROWSER_OP_TIMEOUT_MS`

### Keep sessions logged in

- Use a persistent browser profile directory
- In Docker, keep the `chrome_profile_data` volume
- Use `HEADLESS=false` with `ENABLE_VNC=1` if you want to log in once and reuse the session later

## Development

Run locally:

```bash
npm install
npm start
```

Test MCP integration:

```bash
npm run test:mcporter
```

## Security Notes

- This project drives a real browser and can access live web content
- Be careful before exposing the HTTP endpoint outside a trusted environment
- Do not commit real credentials or personal browser profiles into the repository

See `SECURITY.md` for reporting guidance.

## Contributing

Contributions are welcome.

See `CONTRIBUTING.md` for setup and pull request guidance.

## License

Licensed under the Apache License 2.0. See `LICENSE`.
