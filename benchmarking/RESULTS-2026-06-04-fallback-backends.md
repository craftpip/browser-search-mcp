# Benchmark: Smart Fallback Backends

**Date:** 2026-06-04
**Mode:** Live MCP HTTP server at `http://localhost:3000/mcp`
**Query:** `model context protocol`
**Limit:** 3
**Iterations:** 3
**Warmup:** 0
**Unique queries:** enabled
**Backend config:** `BROWSER_BACKEND=lightpanda`
**Fallback order:** `duckduckgo/http` -> `bing/lightpanda`, `mojeek/lightpanda` -> `google/chromium`, `duckduckgo_chromium/chromium`

## Summary

| Route | Run 1 | Run 2 | Run 3 | Min | P50 | P95 | Max | Avg | Status |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `duckduckgo` HTTP | 1036.74ms | 969.68ms | 933.91ms | 933.91ms | 969.68ms | 1036.74ms | 1036.74ms | 980.11ms | 3 results |
| `bing` Lightpanda | 1068.76ms | 1000.13ms | 1115.37ms | 1000.13ms | 1068.76ms | 1115.37ms | 1115.37ms | 1061.42ms | 3 results |
| `mojeek` Lightpanda | 1714.19ms | 1004.63ms | 1003.63ms | 1003.63ms | 1004.63ms | 1714.19ms | 1714.19ms | 1240.82ms | no results for unique timestamped queries |
| `google` Chromium | 1968.53ms | 1242.09ms | 1212.11ms | 1212.11ms | 1242.09ms | 1968.53ms | 1968.53ms | 1474.24ms | 3 results |
| `duckduckgo_chromium` Chromium | 2110.81ms | 1485.38ms | 1547.23ms | 1485.38ms | 1547.23ms | 2110.81ms | 2110.81ms | 1714.47ms | 3 results |
| Default smart fallback | 1005.1ms | 930.81ms | 919.43ms | 919.43ms | 930.81ms | 1005.1ms | 1005.1ms | 951.78ms | 3 results |

## Key Findings

- Default smart fallback was reliable and fast in this run: average `951.78ms`.
- `duckduckgo/http` is working and returned 3 results on every run.
- `bing/lightpanda` is working and returned 3 results on every run.
- `mojeek/lightpanda` is working, but the benchmark used unique timestamped queries that Mojeek returned no results for. This no longer opens a circuit breaker.
- `google/chromium` is working and returned 3 results on every run.
- `duckduckgo_chromium/chromium` is working and returned 3 results on every run.
- Post-run health showed no open circuit breakers.

## Post-Run Health

```json
{
  "ok": true,
  "backend": "lightpanda",
  "browserConnected": true,
  "lightpandaConnected": true,
  "searchEngines": ["duckduckgo", "bing", "mojeek", "google", "duckduckgo_chromium"],
  "searchWindows": {
    "total": 3,
    "byEngine": {
      "_shared": { "total": 1, "inUse": 0, "pending": 0, "persistent": 0 },
      "google": { "total": 1, "inUse": 0, "pending": 0, "persistent": 0 },
      "duckduckgo_chromium": { "total": 1, "inUse": 0, "pending": 0, "persistent": 0 }
    }
  },
  "searchRouteCircuitBreakers": []
}
```

## Raw Output

```text
MCP endpoint: http://localhost:3000/mcp
query: "model context protocol", limit: 3, iterations: 3, warmup: 0

duckduckgo run 1/3: 1036.74ms  results=3
duckduckgo run 2/3: 969.68ms  results=3
duckduckgo run 3/3: 933.91ms  results=3

  duckduckgo
  runs: 3
  min:  933.91ms
  p50:  969.68ms
  p95:  1036.74ms
  max:  1036.74ms
  avg:  980.11ms
bing run 1/3: 1068.76ms  results=3
bing run 2/3: 1000.13ms  results=3
bing run 3/3: 1115.37ms  results=3

  bing
  runs: 3
  min:  1000.13ms
  p50:  1068.76ms
  p95:  1115.37ms
  max:  1115.37ms
  avg:  1061.42ms
mojeek run 1/3: 1714.19ms  no-results
mojeek run 2/3: 1004.63ms  no-results
mojeek run 3/3: 1003.63ms  no-results

  mojeek
  runs: 3
  min:  1003.63ms
  p50:  1004.63ms
  p95:  1714.19ms
  max:  1714.19ms
  avg:  1240.82ms
google run 1/3: 1968.53ms  results=3
google run 2/3: 1242.09ms  results=3
google run 3/3: 1212.11ms  results=3

  google
  runs: 3
  min:  1212.11ms
  p50:  1242.09ms
  p95:  1968.53ms
  max:  1968.53ms
  avg:  1474.24ms
duckduckgo_chromium run 1/3: 2110.81ms  results=3
duckduckgo_chromium run 2/3: 1485.38ms  results=3
duckduckgo_chromium run 3/3: 1547.23ms  results=3

  duckduckgo_chromium
  runs: 3
  min:  1485.38ms
  p50:  1547.23ms
  p95:  2110.81ms
  max:  2110.81ms
  avg:  1714.47ms
all run 1/3: 1005.1ms  results=3
all run 2/3: 930.81ms  results=3
all run 3/3: 919.43ms  results=3

combined (all engines)
  runs: 3
  min:  919.43ms
  p50:  930.81ms
  p95:  1005.1ms
  max:  1005.1ms
  avg:  951.78ms
```
