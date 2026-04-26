@echo off
setlocal

if "%~1"=="" (
  echo Usage: %~nx0 "query" [limit] [engine]
  echo Example: %~nx0 "openai mcp" 5 bing
  exit /b 1
)

set "QUERY=%~1"
set "LIMIT=%~2"
set "ENGINE=%~3"

if "%LIMIT%"=="" set "LIMIT=5"
if "%ENGINE%"=="" set "ENGINE=bing"

mcporter call web-search.search query="%QUERY%" limit=%LIMIT% engine=%ENGINE%

exit /b %errorlevel%
