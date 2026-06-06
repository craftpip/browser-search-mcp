# Benchmark: Page Reuse Fix (Direct search URL navigation)

**Date:** 2026-06-04
**Branch:** feature/lightpanda
**Config:** Lightpanda for Bing, Chromium for DuckDuckGo/Google
**Query:** "latest AI news 2026", limit=5, iterations=3, warmup=1

## Results

| Engine | Run 1 | Run 2 | Run 3 | Avg |
|--------|-------|-------|-------|-----|
| Bing (Lightpanda) | 934ms | 1009ms | 1317ms | 1087ms |
| DuckDuckGo (Chromium) | 1222ms | 1031ms | 1250ms | 1168ms |
| Google (Chromium) | 1757ms | 2315ms | 2058ms | 2043ms |
| Combined | 1508ms | 1660ms | 1939ms | 1702ms |

**Key improvement:** Page reuse now works reliably. No 50s timeouts.
Bing 2/3 and 3/3 reuse the same Lightpanda page with sub-second latency.

**Root cause:** `input.press("Enter")` on a reused page (after `page.goto` back to
homepage) did not trigger form submission/navigation. The interaction model
(type → Enter → wait) was fragile on reused pages.

**Fix:** Navigate directly to the search URL
(`/search?q=<query>`) instead of going through the homepage interaction flow.
This eliminates typing, Enter key, and submit button dependencies.
