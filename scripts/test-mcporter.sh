#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${MCP_HTTP_URL:-http://127.0.0.1:3000/mcp}"
HEALTH_URL="${MCP_HEALTH_URL:-http://127.0.0.1:3000/health}"
SERVER_NAME="local-browser-search"
CONFIG_PATH="$(mktemp /tmp/mcporter-browser-search.XXXXXX.json)"
printf '{"mcpServers":{}}\n' >"$CONFIG_PATH"

cleanup() {
  rm -f "$CONFIG_PATH"
}
trap cleanup EXIT

echo "[mcporter-test] installing mcporter"
npm install --no-save mcporter >/dev/null

echo "[mcporter-test] checking MCP health endpoint"
node -e '
  const url = process.argv[1];
  fetch(url)
    .then(async (res) => {
      const text = await res.text();
      if (!res.ok) throw new Error(`health request failed (${res.status}): ${text}`);
      const payload = JSON.parse(text || "{}");
      if (!payload.ok) throw new Error(`health payload not ok: ${text}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
' "$HEALTH_URL"

echo "[mcporter-test] adding server config"
npx mcporter config add "$SERVER_NAME" --url "$BASE_URL" --transport http --persist "$CONFIG_PATH"

echo "[mcporter-test] listing tools"
LIST_JSON="$(npx mcporter list "$SERVER_NAME" --config "$CONFIG_PATH" --json)"
node -e '
  const payload = JSON.parse(process.argv[1]);
  const tools = payload.tools || [];
  const names = tools.map((tool) => tool.name);
  const required = ["web_search", "web_open_page", "web_page_screenshot"];
  for (const key of required) {
    if (!names.includes(key)) {
      throw new Error(`missing tool ${key}. found: ${names.join(",")}`);
    }
  }
  console.log(`[mcporter-test] tools ok: ${names.join(", ")}`);
' "$LIST_JSON"

echo "[mcporter-test] calling web_search"
CALL_JSON="$(npx mcporter call "$SERVER_NAME.web_search" query='mcp protocol' limit=1 engine=duckduckgo_api --config "$CONFIG_PATH" --output json)"
node -e '
  const payload = JSON.parse(process.argv[1]);
  const content = payload.content || [];
  const text = content[0]?.text || "";
  if (!text.includes("result id")) {
    throw new Error(`unexpected web_search payload: ${process.argv[1]}`);
  }
  const titleMatch = text.match(/\*\*([^*]+)\*\*/);
  const title = titleMatch ? titleMatch[1] : "(untitled)";
  console.log(`[mcporter-test] call ok: ${title}`);
' "$CALL_JSON"

echo "[mcporter-test] PASS"
