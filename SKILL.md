# Browser Search MCP Skill

This skill provides instructions for working with the browser-search-mcp project.

## Project Overview

MCP server that drives a real Chromium browser with Puppeteer for web search, page extraction, and screenshots.

## Key Files

- `src/mcp-server.js` - Main MCP server entry point
- `src/config.js` - Environment and runtime configuration
- `src/browser.js` - Browser lifecycle and lock recovery
- `src/search.js` - Search and extraction logic

## Common Tasks

### Running the server
```bash
npm start
```

### Testing
```bash
npm run test:mcporter
```

### Docker
```bash
docker build -t browser-search-mcp .
docker run -d --name browser-search-mcp -p 3000:3000 browser-search-mcp
```

## Tool Usage

When the MCP server is running, agents can use:
- `web_search` - Search the web
- `web_open_page` - Extract readable text from pages
- `web_page_screenshot` - Capture page screenshots

## Important Notes

- Uses real Chromium browser (not mock)
- Supports persistent Chrome profiles
- Handles profile lock recovery automatically
- Can run in Docker with VNC/noVNC for debugging
