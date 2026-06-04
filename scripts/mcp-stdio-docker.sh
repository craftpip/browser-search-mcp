#!/usr/bin/env sh
set -eu

IMAGE="${MCP_DOCKER_IMAGE:-browser-search-mcp-browser-search-mcp:latest}"
CONTAINER="${MCP_DOCKER_CONTAINER:-browser-search-mcp-landing}"
PROFILE_VOLUME="${MCP_PROFILE_VOLUME:-chrome_profile_data}"
HOST_VNC_PORT="${MCP_VNC_PORT:-5901}"
HOST_NOVNC_PORT="${MCP_NOVNC_PORT:-7901}"

ENABLE_VNC="${ENABLE_VNC:-1}"
HEADLESS="${HEADLESS:-false}"
PRELAUNCH_BROWSER="${PRELAUNCH_BROWSER:-1}"
CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-/data/chrome}"
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-Default}"
SEARCH_ENGINES="${SEARCH_ENGINES:-duckduckgo,bing,mojeek,google,duckduckgo_chromium}"
BROWSER_OP_TIMEOUT_MS="${BROWSER_OP_TIMEOUT_MS:-60000}"
NAV_WAIT_UNTIL="${NAV_WAIT_UNTIL:-networkidle2}"
ENABLE_HTTP_HEALTH="${ENABLE_HTTP_HEALTH:-0}"
HEALTH_PORT="${HEALTH_PORT:-3000}"
ENABLE_STDIO_MCP="${ENABLE_STDIO_MCP:-1}"
ENABLE_HTTP_MCP="${ENABLE_HTTP_MCP:-0}"
DISPLAY="${DISPLAY:-:99}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Docker image not found: $IMAGE" >&2
  echo "Build or tag it first, for example:" >&2
  echo "  docker build -t browser-search-mcp ." >&2
  echo "  docker tag browser-search-mcp:latest $IMAGE" >&2
  exit 1
fi

if ! docker ps -a --format '{{.Names}}' | grep -Fx "$CONTAINER" >/dev/null 2>&1; then
  docker create \
    --name "$CONTAINER" \
    -e ENABLE_VNC="$ENABLE_VNC" \
    -e HEADLESS="$HEADLESS" \
    -e PRELAUNCH_BROWSER="$PRELAUNCH_BROWSER" \
    -e CHROME_USER_DATA_DIR="$CHROME_USER_DATA_DIR" \
    -e CHROME_PROFILE_DIR="$CHROME_PROFILE_DIR" \
    -e SEARCH_ENGINES="$SEARCH_ENGINES" \
    -e BROWSER_OP_TIMEOUT_MS="$BROWSER_OP_TIMEOUT_MS" \
    -e NAV_WAIT_UNTIL="$NAV_WAIT_UNTIL" \
    -e ENABLE_HTTP_HEALTH="$ENABLE_HTTP_HEALTH" \
    -e HEALTH_PORT="$HEALTH_PORT" \
    -e ENABLE_STDIO_MCP="$ENABLE_STDIO_MCP" \
    -e ENABLE_HTTP_MCP="$ENABLE_HTTP_MCP" \
    -e DISPLAY="$DISPLAY" \
    -v "$PROFILE_VOLUME:/data/chrome" \
    -p "$HOST_VNC_PORT:5900" \
    -p "$HOST_NOVNC_PORT:7900" \
    -p "$HEALTH_PORT:3000" \
    "$IMAGE" tail -f /dev/null >/dev/null
fi

if ! docker ps --format '{{.Names}}' | grep -Fx "$CONTAINER" >/dev/null 2>&1; then
  docker start "$CONTAINER" >/dev/null
fi

exec docker exec -i \
  -e ENABLE_VNC="$ENABLE_VNC" \
  -e HEADLESS="$HEADLESS" \
  -e PRELAUNCH_BROWSER="$PRELAUNCH_BROWSER" \
  -e CHROME_USER_DATA_DIR="$CHROME_USER_DATA_DIR" \
  -e CHROME_PROFILE_DIR="$CHROME_PROFILE_DIR" \
  -e SEARCH_ENGINES="$SEARCH_ENGINES" \
  -e BROWSER_OP_TIMEOUT_MS="$BROWSER_OP_TIMEOUT_MS" \
  -e NAV_WAIT_UNTIL="$NAV_WAIT_UNTIL" \
  -e ENABLE_HTTP_HEALTH="$ENABLE_HTTP_HEALTH" \
  -e HEALTH_PORT="$HEALTH_PORT" \
  -e ENABLE_STDIO_MCP="$ENABLE_STDIO_MCP" \
  -e ENABLE_HTTP_MCP="$ENABLE_HTTP_MCP" \
  -e DISPLAY="$DISPLAY" \
  "$CONTAINER" node src/mcp-server.js
