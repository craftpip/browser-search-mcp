@echo off
setlocal enableextensions enabledelayedexpansion

set "SERVICE_NAME=%SERVICE_NAME%"
if "%SERVICE_NAME%"=="" set "SERVICE_NAME=browser-search-mcp"

set "DEST_DIR=%DEST_DIR%"
if "%DEST_DIR%"=="" set "DEST_DIR=/data/chrome"

set "WIPE_DEST=0"
set "VERBOSE=0"
set "PROGRESS=0"
set "SOURCE_DIR="

if "%~1"=="" goto after_args

:parse_args
if "%~1"=="" goto after_args

if /I "%~1"=="--source" (
  if "%~2"=="" (
    echo Missing value for --source 1>&2
    goto usage_error
  )
  set "SOURCE_DIR=%~2"
  shift
  shift
  goto parse_args
)

if /I "%~1"=="--wipe" (
  set "WIPE_DEST=1"
  shift
  goto parse_args
)

if /I "%~1"=="--verbose" (
  set "VERBOSE=1"
  shift
  goto parse_args
)

if /I "%~1"=="--progress" (
  set "PROGRESS=1"
  shift
  goto parse_args
)

if /I "%~1"=="--help" goto usage_ok

echo Unknown argument: %~1 1>&2
goto usage_error

:after_args
if "%SOURCE_DIR%"=="" (
  echo Missing --source argument 1>&2
  goto usage_error
)

if not exist "%SOURCE_DIR%\" (
  echo Source directory does not exist: %SOURCE_DIR% 1>&2
  exit /b 1
)

set "CONTAINER_ID="
for /f "usebackq delims=" %%I in (`docker compose ps -q "%SERVICE_NAME%"`) do set "CONTAINER_ID=%%I"
if "%CONTAINER_ID%"=="" (
  echo Service '%SERVICE_NAME%' is not running. Start it with: docker compose up -d 1>&2
  exit /b 1
)

echo Preparing destination: %DEST_DIR%
docker compose exec -T "%SERVICE_NAME%" sh -lc "mkdir -p '%DEST_DIR%'"
if errorlevel 1 exit /b 1

if "%WIPE_DEST%"=="1" (
  echo Wiping existing destination contents...
  docker compose exec -T "%SERVICE_NAME%" sh -lc "find '%DEST_DIR%' -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
  if errorlevel 1 exit /b 1
)

echo Copying profile from '%SOURCE_DIR%' to container '%SERVICE_NAME%:%DEST_DIR%'...
if "%VERBOSE%"=="1" (
  tar -C "%SOURCE_DIR%" -cvf - . | docker compose exec -T "%SERVICE_NAME%" sh -lc "tar -C '%DEST_DIR%' -xvf -"
) else if "%PROGRESS%"=="1" (
  call :get_dir_size_mb "%SOURCE_DIR%" SOURCE_MB
  if not defined SOURCE_MB set "SOURCE_MB=0"
  set "STATUS_FILE=%TEMP%\clone-chrome-copy-%RANDOM%-%RANDOM%.status"
  if exist "%STATUS_FILE%" del /f /q "%STATUS_FILE%" >nul 2>&1

  start "" /b cmd /c "tar -C \"%SOURCE_DIR%\" -cf - . ^| docker compose exec -T \"%SERVICE_NAME%\" sh -lc \"tar -C '%DEST_DIR%' -xf -\" && (echo 0>\"%STATUS_FILE%\") || (echo 1>\"%STATUS_FILE%\")"

  :progress_loop
  if exist "%STATUS_FILE%" goto progress_done

  call :get_container_size_mb "%SERVICE_NAME%" "%DEST_DIR%" DEST_MB
  if not defined DEST_MB set "DEST_MB=0"

  if "%SOURCE_MB%"=="0" (
    echo Progress: !DEST_MB!MB copied
  ) else (
    set /a PCT=(!DEST_MB! * 100) / !SOURCE_MB!
    if !PCT! gtr 100 set "PCT=100"
    echo Progress: !DEST_MB!MB / !SOURCE_MB!MB ^(!PCT!%%^)
  )

  timeout /t 3 /nobreak >nul
  goto progress_loop

  :progress_done
  set /p COPY_EXIT=<"%STATUS_FILE%"
  del /f /q "%STATUS_FILE%" >nul 2>&1
  if not "!COPY_EXIT!"=="0" exit /b 1
) else (
  tar -C "%SOURCE_DIR%" -cf - . | docker compose exec -T "%SERVICE_NAME%" sh -lc "tar -C '%DEST_DIR%' -xf -"
)
if errorlevel 1 exit /b 1

echo Done. Imported profile into %DEST_DIR%
exit /b 0

:usage_ok
call :print_usage
exit /b 0

:usage_error
call :print_usage 1>&2
exit /b 1

:print_usage
echo Clone a local Chrome/Chromium user data directory into the running container.
echo.
echo Usage:
echo   scripts\clone-chrome-userdir.bat --source "C:\path\to\user-data-dir" [--wipe] [--verbose] [--progress]
echo.
echo Options:
echo   --source ^<path^>   Required. Local Chrome/Chromium user data directory.
echo   --wipe            Remove existing files in container DEST_DIR before copy.
echo   --verbose         Show files as they are copied.
echo   --progress        Show periodic size-based progress updates.
echo   --help            Show this help message.
echo.
echo Environment overrides:
echo   SERVICE_NAME      docker compose service name (default: browser-search-mcp)
echo   DEST_DIR          destination in container (default: /data/chrome)
echo.
echo Notes:
echo   - Make sure the target container is running (docker compose up -d).
echo   - Copying while local Chrome is open may include lock files; the server has
echo     lock recovery, but closing local Chrome before copy is recommended.
goto :eof

:get_dir_size_mb
set "%~2="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$size=(Get-ChildItem -LiteralPath '%~1' -Recurse -Force -ErrorAction SilentlyContinue ^| Measure-Object -Property Length -Sum).Sum; if($null -eq $size){$size=0}; [int][math]::Ceiling($size / 1MB)"`) do set "%~2=%%I"
goto :eof

:get_container_size_mb
set "%~3=0"
for /f "tokens=1" %%I in ('docker compose exec -T "%~1" sh -lc "du -sm '%~2' 2>/dev/null || echo 0 '%~2'"') do set "%~3=%%I"
goto :eof
