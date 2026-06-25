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
| `SEARCH_ENGINES` | `duckduckgo_api,google_cb,google_lp,bing_lp,duckduckgo_cb,bing_cb` | Search engines to use |
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

## Development Commands

```bash
npm start          # Run MCP server over stdio
npm run test:mcporter  # Test MCP integration
docker compose build   # Build Docker image
docker compose down && docker compose up -d  # Restart containers
```

## Project Learnings

### Branch switch + Docker deploy workflow

**Created:** 2026-06-13
**Last updated:** 2026-06-13

**Trigger:** User asked to check out a branch, build, and restart container.

**Mistake / Problem:** Tried `npm install` directly on the host instead of using `docker compose build`. The project uses Docker for building and running.

**Correct Approach:**
1. `git checkout <branch-name>` to switch branches
2. `docker compose build` to rebuild the Docker image with the new code
3. `docker compose down && docker compose up -d` to restart the container
4. Check health: `docker exec <container> curl -s localhost:3000/health`

**Verification:** Health endpoint returns `{"ok":true}` with the expected backend and no open circuit breakers.

**Scope:** This project runs fully in Docker. Always use Docker commands for building and deploying.

**Related terms:** branch, checkout, build, deploy, docker compose, restart

### 2026-06-11 - Diagnosing container health

**Trigger:** User asked "Is this container working?" and later "It's time to learn."

**Mistake / Problem:** When asked to check if the containerized MCP server was working:
1. Ran `ps aux` on the host instead of checking Docker containers first
2. Tried `journalctl` and `strace` which don't apply to Docker containers
3. Didn't read `docker-compose.yml` to understand the full setup
4. Wasted multiple round trips on host-level diagnostics
5. The container was actually running fine — the real issue was all search route circuit breakers were open

**Correct Approach:**
1. Start with `docker ps -a` to see container status
2. Check `docker logs <container-name>` for runtime errors
3. Read `docker-compose.yml` to understand config (browser backend, timeouts, env vars)
4. Check health endpoint: `docker exec <container> curl -s localhost:3000/health`
5. Check processes: `docker exec <container> ps aux`
6. The health endpoint also shows circuit breaker status — check for open routes

**Verification:** Health endpoint returns `{"browserConnected":true,"lightpandaConnected":true}` but `searchRouteCircuitBreakers` may show open routes with remaining cooldown.

**Scope:** This project runs in Docker with a container name like `browser-search-mcp-browser-search-mcp-1`. Always use Docker commands, not host commands, to diagnose the container.

### 2026-06-11 - Container has no outbound internet (DOCKER-USER iptables)

**Trigger:** All search engines failing with timeouts despite host having internet. `curl` from inside container returned 000.

**Mistake / Problem:** Spent time reading code, checking circuit breakers, and tracing iptables chains before checking the most basic thing — can the container reach the internet at all?

**Correct Approach:**
1. First check: `docker exec <container> curl -s --max-time 5 https://duckduckgo.com`
2. If that fails, check: `docker exec <container> curl -s --max-time 5 http://1.1.1.1`
3. Run `iptables -L DOCKER-USER -n -v` on the **host** to look for blanket DROP rules
4. The fix: `sudo iptables -I DOCKER-USER 4 -s 172.16.0.0/12 -j ACCEPT`
5. This fix is **not persistent** across reboots — needs to be saved or added to a startup script

**Root cause:** The `DOCKER-USER` chain had `RETURN` for RELATED/ESTABLISHED, a VPN subnet, and loopback, then a catch-all `DROP`. Outbound NEW connections from Docker bridge networks fell through to the DROP.

**Verification:** After fix, `docker exec <container> curl -s --max-time 5 https://duckduckgo.com` returns HTTP 200.

**Scope:** Host-level iptables configuration issue. Not specific to this project's code. May recur on reboot.
