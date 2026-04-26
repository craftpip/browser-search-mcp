import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";

const WORKDIR = "/mnt/c/www/browser-search-mcp";
const HOST_HTTP_BASE = process.env.HOST_HTTP_BASE || "http://host.docker.internal:3000";

process.chdir(WORKDIR);

async function testStdioMcp(label, command, args = [], env = {}) {
  const client = new Client(
    { name: "transport-matrix-test", version: "1.0.0" },
    { capabilities: {} }
  );

  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env }
  });

  await client.connect(transport);

  try {
    const tools = await client.listTools();
    const toolNames = (tools?.tools || []).map((tool) => tool.name);
    if (!toolNames.includes("web_search") || !toolNames.includes("web_open_page")) {
      throw new Error(`${label}: expected tools missing: ${JSON.stringify(toolNames)}`);
    }

    const search = await client.callTool({
      name: "web_search",
      arguments: { query: "mcp protocol", limit: 3, engine: "bing" }
    });

    const searchText = search?.content?.[0]?.text || "";
    const payload = JSON.parse(searchText);
    if (!Array.isArray(payload.results) || !payload.results.length) {
      throw new Error(`${label}: search returned unexpected payload: ${searchText}`);
    }

    const openMany = await client.callTool({
      name: "web_open_page",
      arguments: {
        urls: ["https://example.com", "https://modelcontextprotocol.io/docs/getting-started/intro"],
        maxChars: 400
      }
    });

    const openText = openMany?.content?.[0]?.text || "";
    const openPayload = JSON.parse(openText);
    if (openPayload.count !== 2) {
      throw new Error(`${label}: parallel open count mismatch: ${openText}`);
    }
    if (!Array.isArray(openPayload.results) || openPayload.results.length !== 2) {
      throw new Error(`${label}: parallel open results missing: ${openText}`);
    }

    return { details: `tools=${toolNames.join(",")}` };
  } finally {
    await client.close();
  }
}

async function testWebHost() {
  const healthRes = await fetch(`${HOST_HTTP_BASE}/health`);
  const healthText = await healthRes.text();
  if (!healthRes.ok) {
    throw new Error(`Host web /health failed (${healthRes.status}): ${healthText}`);
  }

  const health = JSON.parse(healthText);
  if (!health.ok) {
    throw new Error(`Host web /health payload not ok: ${healthText}`);
  }

  const searchRes = await fetch(
    `${HOST_HTTP_BASE}/search?q=${encodeURIComponent("mcp protocol")}&limit=1&engine=bing`
  );
  const searchText = await searchRes.text();
  if (!searchRes.ok) {
    throw new Error(`Host web /search failed (${searchRes.status}): ${searchText}`);
  }

  const search = JSON.parse(searchText);
  if (!Array.isArray(search.results)) {
    throw new Error(`Host web /search payload missing results: ${searchText}`);
  }

  const extractRes = await fetch(
    `${HOST_HTTP_BASE}/extract?urls=${encodeURIComponent("https://example.com||https://modelcontextprotocol.io/docs/getting-started/intro")}&maxChars=400`
  );
  const extractText = await extractRes.text();
  if (!extractRes.ok) {
    throw new Error(`Host web /extract refs failed (${extractRes.status}): ${extractText}`);
  }

  const extractPayload = JSON.parse(extractText);
  if (extractPayload.count !== 2) {
    throw new Error(`Host web /extract refs count mismatch: ${extractText}`);
  }
  if (!Array.isArray(extractPayload.results) || extractPayload.results.length !== 2) {
    throw new Error(`Host web /extract refs payload missing results: ${extractText}`);
  }

  return { details: `results=${search.resultCount ?? search.results.length}` };
}

async function runShell(command) {
  return await new Promise((resolve) => {
    const child = spawn(command, {
      cwd: WORKDIR,
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(String(chunk)));
    child.stderr.on("data", (chunk) => err.push(String(chunk)));
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stdout: out.join(""), stderr: err.join("") });
    });
  });
}

async function testWebInDocker() {
  const probe = await runShell(
    "docker exec browser-search-mcp-landing node -e \"fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e);process.exit(1);})\""
  );

  if (probe.code !== 0) {
    throw new Error(`Docker web /health command failed: ${probe.stderr || probe.stdout}`);
  }

  const payload = JSON.parse(probe.stdout.trim() || "{}");
  if (!payload.ok) {
    throw new Error(`Docker web /health payload not ok: ${probe.stdout}`);
  }

  const multi = await runShell(
    "docker exec browser-search-mcp-landing node -e \"fetch('http://127.0.0.1:3000/extract?urls=' + encodeURIComponent('https://example.com||https://modelcontextprotocol.io')).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e);process.exit(1);})\""
  );

  if (multi.code !== 0) {
    throw new Error(`Docker web /extract urls command failed: ${multi.stderr || multi.stdout}`);
  }

  const multiPayload = JSON.parse(multi.stdout.trim() || "{}");
  if (multiPayload.count !== 2 || !Array.isArray(multiPayload.results) || multiPayload.results.length !== 2) {
    throw new Error(`Docker web /extract urls payload invalid: ${multi.stdout}`);
  }

  return { details: "health ok inside container" };
}

async function main() {
  const tests = [
    {
      label: "1) MCP CLI",
      run: () =>
        testStdioMcp(
          "MCP CLI",
          "sh",
          ["scripts/mcp-stdio-docker.sh"],
          {
            PRELAUNCH_BROWSER: "0",
            ENABLE_HTTP_MCP: "0",
            ENABLE_HTTP_HEALTH: "0"
          }
        )
    },
    {
      label: "2) Web",
      run: () => testWebHost()
    },
    {
      label: "3) Docker MCP CLI",
      run: () =>
        testStdioMcp("Docker MCP CLI", "docker", [
          "exec",
          "-i",
          "-e",
          "ENABLE_STDIO_MCP=1",
          "-e",
          "PRELAUNCH_BROWSER=0",
          "-e",
          "ENABLE_HTTP_MCP=0",
          "-e",
          "ENABLE_HTTP_HEALTH=0",
          "browser-search-mcp-landing",
          "node",
          "src/mcp-server.js"
        ])
    },
    {
      label: "4) Docker Web",
      run: () => testWebInDocker()
    }
  ];

  let failed = false;
  for (const test of tests) {
    const start = Date.now();
    try {
      const result = await test.run();
      const ms = Date.now() - start;
      console.log(`PASS ${test.label} (${ms}ms) ${result.details || ""}`);
    } catch (error) {
      failed = true;
      const ms = Date.now() - start;
      console.log(`FAIL ${test.label} (${ms}ms) ${error.message}`);
    }
  }

  if (failed) process.exit(1);
}

await main();
