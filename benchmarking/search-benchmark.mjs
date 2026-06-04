import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL || "http://localhost:3000/mcp";
const QUERY = process.env.BENCH_QUERY || "latest AI news 2026";
const LIMIT = parseInt(process.env.BENCH_LIMIT || "5", 10);
const ITERATIONS = parseInt(process.env.BENCH_ITERATIONS || "1", 10);
const WARMUP = parseInt(process.env.BENCH_WARMUP || "0", 10);
const UNIQUE_QUERIES = process.env.BENCH_UNIQUE !== "0";
const ENGINE = process.env.BENCH_ENGINE || ""; // single engine test: duckduckgo, bing, mojeek, google, or duckduckgo_chromium

function round(v) { return Math.round(v * 100) / 100; }

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(name, values) {
  if (!values.length) {
    console.log(`\n${name}`);
    console.log("  runs: 0");
    console.log("  no successful runs");
    return;
  }
  const total = values.reduce((s, v) => s + v, 0);
  const avg = values.length ? total / values.length : 0;
  console.log(`\n${name}`);
  console.log(`  runs: ${values.length}`);
  console.log(`  min:  ${round(Math.min(...values))}ms`);
  console.log(`  p50:  ${round(percentile(values, 50))}ms`);
  console.log(`  p95:  ${round(percentile(values, 95))}ms`);
  console.log(`  max:  ${round(Math.max(...values))}ms`);
  console.log(`  avg:  ${round(avg)}ms`);
}

function parseResultStatus(content) {
  const text = String(content || "");
  const resultCount = text.match(/Results\s*\((\d+)\)/)?.[1];
  if (resultCount !== undefined) return `results=${resultCount}`;
  if (/No results returned\./.test(text) && /\*\*Errors:\*\*/.test(text)) return "error";
  if (/No results returned\./.test(text)) return "no-results";
  return "unknown";
}

async function main() {
  console.log(`MCP endpoint: ${MCP_URL}`);
  console.log(`query: ${JSON.stringify(QUERY)}, limit: ${LIMIT}, iterations: ${ITERATIONS}, warmup: ${WARMUP}\n`);

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "search-benchmark", version: "1.0.0" });

  await client.connect(transport);

  const engines = ENGINE ? [ENGINE] : ["duckduckgo", "bing", "mojeek", "google", "duckduckgo_chromium"];

  function makeQuery(run) {
    return UNIQUE_QUERIES ? `${QUERY} ${run} ${Date.now()}` : QUERY;
  }

  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    await client.callTool({ name: "web_search", arguments: { query: makeQuery(i), limit: LIMIT } });
  }

  // Per-engine benchmark
  for (const engine of engines) {
    const ev = [];
    let failures = 0;
    for (let i = 1; i <= ITERATIONS; i++) {
      const q = makeQuery(i);
      const args = { query: q, limit: LIMIT, engine };
      const start = performance.now();
      try {
        const result = await client.callTool({ name: "web_search", arguments: args });
        const duration = performance.now() - start;
        const content = result?.content?.[0]?.text || "";
        const status = parseResultStatus(content);
        ev.push(duration);
        console.log(`${engine} run ${i}/${ITERATIONS}: ${round(duration)}ms  ${status}`);
      } catch (error) {
        const duration = performance.now() - start;
        failures += 1;
        console.log(`${engine} run ${i}/${ITERATIONS}: ${round(duration)}ms  error=${error.message}`);
      }
    }
    summarize(`  ${engine}`, ev);
    if (failures) console.log(`  failures: ${failures}`);
  }

  // Combined benchmark (all engines)
  if (engines.length > 1) {
    const combined = [];
    for (let i = 1; i <= ITERATIONS; i++) {
      const q = makeQuery(i);
      const start = performance.now();
      const result = await client.callTool({ name: "web_search", arguments: { query: q, limit: LIMIT } });
      const duration = performance.now() - start;
      combined.push(duration);

      const content = result?.content?.[0]?.text || "";
      const status = parseResultStatus(content);
      console.log(`all run ${i}/${ITERATIONS}: ${round(duration)}ms  ${status}`);
    }
    summarize("combined (all engines)", combined);
  }

  await client.close();
}

main().catch(err => {
  console.error(`Benchmark failed: ${err.message}`);
  process.exitCode = 1;
});
