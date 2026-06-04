import { performance } from "node:perf_hooks";
import { browserSearch, browserOpenAndExtract, browserCaptureScreenshot } from "../src/search.js";
import { getBrowserManager } from "../src/browser.js";

function readIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function readBoolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(name, values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  const avg = values.length ? total / values.length : 0;
  return {
    name,
    runs: values.length,
    minMs: round(Math.min(...values)),
    p50Ms: round(percentile(values, 50)),
    p95Ms: round(percentile(values, 95)),
    maxMs: round(Math.max(...values)),
    avgMs: round(avg)
  };
}

async function benchCase(name, iterations, fn) {
  const values = [];

  for (let run = 1; run <= iterations; run += 1) {
    const started = performance.now();
    await fn(run);
    const duration = performance.now() - started;
    values.push(duration);
    process.stdout.write(`${name} run ${run}/${iterations}: ${round(duration)}ms\n`);
  }

  return summarize(name, values);
}

function printSummary(rows) {
  process.stdout.write("\nBenchmark summary\n");
  process.stdout.write("name\truns\tmin\tp50\tp95\tmax\tavg\n");

  for (const row of rows) {
    process.stdout.write(
      `${row.name}\t${row.runs}\t${row.minMs}ms\t${row.p50Ms}ms\t${row.p95Ms}ms\t${row.maxMs}ms\t${row.avgMs}ms\n`
    );
  }
}

async function main() {
  const query = process.env.BENCH_QUERY || "latest Node.js release";
  const limit = readIntEnv("BENCH_LIMIT", 5);
  const iterations = readIntEnv("BENCH_ITERATIONS", 3);
  const warmup = readIntEnv("BENCH_WARMUP", 1);
  const maxChars = readIntEnv("BENCH_MAX_CHARS", 8000);
  const screenshot = readBoolEnv("BENCH_SCREENSHOT", false);

  process.stdout.write(
    [
      "Running benchmark with config:",
      `query=${JSON.stringify(query)}`,
      `limit=${limit}`,
      `iterations=${iterations}`,
      `warmup=${warmup}`,
      `maxChars=${maxChars}`,
      `screenshot=${screenshot}`
    ].join(" ") + "\n\n"
  );

  const manager = await getBrowserManager();
  const rows = [];

  try {
    await manager.prelaunchIfConfigured().catch(() => null);

    let firstResultUrl = null;
    const searchTask = async () => {
      const result = await browserSearch({ query, limit });
      firstResultUrl = result?.results?.[0]?.url || null;
      if (!firstResultUrl) {
        throw new Error("Search returned no URLs; cannot continue benchmark");
      }
      return result;
    };

    for (let i = 0; i < warmup; i += 1) {
      await searchTask();
    }

    rows.push(await benchCase("web_search", iterations, searchTask));

    const openTask = async () => {
      if (!firstResultUrl) {
        throw new Error("No URL captured from search");
      }
      await browserOpenAndExtract({ url: firstResultUrl, maxChars });
    };

    for (let i = 0; i < warmup; i += 1) {
      await openTask();
    }
    rows.push(await benchCase("web_open_page", iterations, openTask));

    if (screenshot) {
      const screenshotTask = async () => {
        if (!firstResultUrl) {
          throw new Error("No URL captured from search");
        }
        await browserCaptureScreenshot({ url: firstResultUrl, format: "jpeg", quality: 70, fullPage: true });
      };

      for (let i = 0; i < warmup; i += 1) {
        await screenshotTask();
      }
      rows.push(await benchCase("web_page_screenshot", iterations, screenshotTask));
    }

    printSummary(rows);
  } finally {
    await manager.shutdown();
  }
}

main().catch((error) => {
  process.stderr.write(`Benchmark failed: ${error?.message || error}\n`);
  process.exitCode = 1;
});
