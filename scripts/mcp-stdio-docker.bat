@echo off
setlocal

if "%MCP_DOCKER_IMAGE%"=="" set "MCP_DOCKER_IMAGE=browser-search-mcp-browser-search-mcp:latest"
if "%MCP_DOCKER_CONTAINER%"=="" set "MCP_DOCKER_CONTAINER=browser-search-mcp-landing"
if "%MCP_PROFILE_VOLUME%"=="" set "MCP_PROFILE_VOLUME=chrome_profile_data"
if "%MCP_VNC_PORT%"=="" set "MCP_VNC_PORT=5901"
if "%MCP_NOVNC_PORT%"=="" set "MCP_NOVNC_PORT=7901"

if "%ENABLE_VNC%"=="" set "ENABLE_VNC=1"
if "%HEADLESS%"=="" set "HEADLESS=false"
if "%PRELAUNCH_BROWSER%"=="" set "PRELAUNCH_BROWSER=1"
if "%CHROME_USER_DATA_DIR%"=="" set "CHROME_USER_DATA_DIR=/data/chrome"
if "%CHROME_PROFILE_DIR%"=="" set "CHROME_PROFILE_DIR=Default"
if "%SEARCH_ENGINES%"=="" set "SEARCH_ENGINES=duckduckgo,bing,mojeek,google,duckduckgo_chromium"
if "%BROWSER_OP_TIMEOUT_MS%"=="" set "BROWSER_OP_TIMEOUT_MS=60000"
if "%NAV_WAIT_UNTIL%"=="" set "NAV_WAIT_UNTIL=networkidle2"
if "%ENABLE_HTTP_HEALTH%"=="" set "ENABLE_HTTP_HEALTH=0"
if "%HEALTH_PORT%"=="" set "HEALTH_PORT=3000"
if "%ENABLE_STDIO_MCP%"=="" set "ENABLE_STDIO_MCP=1"
if "%ENABLE_HTTP_MCP%"=="" set "ENABLE_HTTP_MCP=0"
if "%DISPLAY%"=="" set "DISPLAY=:99"

docker image inspect "%MCP_DOCKER_IMAGE%" >nul 2>&1
if errorlevel 1 (
  echo Docker image not found: %MCP_DOCKER_IMAGE% 1>&2
  echo Build or tag it first, for example: 1>&2
  echo   docker build -t browser-search-mcp . 1>&2
  echo   docker tag browser-search-mcp:latest %MCP_DOCKER_IMAGE% 1>&2
  exit /b 1
)

set "CONTAINER_EXISTS="
for /f "delims=" %%i in ('docker ps -a --filter "name=%MCP_DOCKER_CONTAINER%" --format "{{.Names}}"') do set "CONTAINER_EXISTS=%%i"

if not defined CONTAINER_EXISTS (
  docker create --name "%MCP_DOCKER_CONTAINER%" ^
    -e ENABLE_VNC=%ENABLE_VNC% ^
    -e HEADLESS=%HEADLESS% ^
    -e PRELAUNCH_BROWSER=%PRELAUNCH_BROWSER% ^
    -e CHROME_USER_DATA_DIR=%CHROME_USER_DATA_DIR% ^
    -e CHROME_PROFILE_DIR=%CHROME_PROFILE_DIR% ^
    -e SEARCH_ENGINES=%SEARCH_ENGINES% ^
    -e BROWSER_OP_TIMEOUT_MS=%BROWSER_OP_TIMEOUT_MS% ^
    -e NAV_WAIT_UNTIL=%NAV_WAIT_UNTIL% ^
    -e ENABLE_HTTP_HEALTH=%ENABLE_HTTP_HEALTH% ^
    -e HEALTH_PORT=%HEALTH_PORT% ^
    -e ENABLE_STDIO_MCP=%ENABLE_STDIO_MCP% ^
    -e ENABLE_HTTP_MCP=%ENABLE_HTTP_MCP% ^
    -e DISPLAY=%DISPLAY% ^
    -v %MCP_PROFILE_VOLUME%:/data/chrome ^
    -p %MCP_VNC_PORT%:5900 ^
    -p %MCP_NOVNC_PORT%:7900 ^
    -p %HEALTH_PORT%:3000 ^
    "%MCP_DOCKER_IMAGE%" tail -f /dev/null >nul
  if errorlevel 1 exit /b 1
)

set "CONTAINER_RUNNING="
for /f "delims=" %%i in ('docker ps --filter "name=%MCP_DOCKER_CONTAINER%" --format "{{.Names}}"') do set "CONTAINER_RUNNING=%%i"

if not defined CONTAINER_RUNNING (
  docker start "%MCP_DOCKER_CONTAINER%" >nul
  if errorlevel 1 exit /b 1
)

docker exec -i ^
  -e ENABLE_VNC=%ENABLE_VNC% ^
  -e HEADLESS=%HEADLESS% ^
  -e PRELAUNCH_BROWSER=%PRELAUNCH_BROWSER% ^
  -e CHROME_USER_DATA_DIR=%CHROME_USER_DATA_DIR% ^
  -e CHROME_PROFILE_DIR=%CHROME_PROFILE_DIR% ^
  -e SEARCH_ENGINES=%SEARCH_ENGINES% ^
  -e BROWSER_OP_TIMEOUT_MS=%BROWSER_OP_TIMEOUT_MS% ^
  -e NAV_WAIT_UNTIL=%NAV_WAIT_UNTIL% ^
  -e ENABLE_HTTP_HEALTH=%ENABLE_HTTP_HEALTH% ^
  -e HEALTH_PORT=%HEALTH_PORT% ^
  -e ENABLE_STDIO_MCP=%ENABLE_STDIO_MCP% ^
  -e ENABLE_HTTP_MCP=%ENABLE_HTTP_MCP% ^
  -e DISPLAY=%DISPLAY% ^
  "%MCP_DOCKER_CONTAINER%" node src/mcp-server.js

exit /b %errorlevel%
