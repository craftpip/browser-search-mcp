#!/bin/sh
set -eu

SERVICE_NAME="${SERVICE_NAME:-browser-search-mcp}"
DEST_DIR="${DEST_DIR:-/data/chrome}"
WIPE_DEST=0
VERBOSE=0
PROGRESS=0

usage() {
  cat <<'EOF'
Clone a local Chrome/Chromium user data directory into the running container.

Usage:
  scripts/clone-chrome-userdir.sh --source "/path/to/user-data-dir" [--wipe] [--verbose] [--progress]

Options:
  --source <path>   Required. Local Chrome/Chromium user data directory.
  --wipe            Remove existing files in container DEST_DIR before copy.
  --verbose         Show files as they are copied.
  --progress        Show periodic size-based progress updates.
  --help            Show this help message.

Environment overrides:
  SERVICE_NAME      docker compose service name (default: browser-search-mcp)
  DEST_DIR          destination in container (default: /data/chrome)

Notes:
  - Make sure the target container is running (docker compose up -d).
  - Copying while local Chrome is open may include lock files; the server has
    lock recovery, but closing local Chrome before copy is recommended.
EOF
}

SOURCE_DIR=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source)
      SOURCE_DIR="${2:-}"
      shift 2
      ;;
    --wipe)
      WIPE_DEST=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    --progress)
      PROGRESS=1
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [ -z "$SOURCE_DIR" ]; then
  echo "Missing --source argument" >&2
  usage
  exit 1
fi

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Source directory does not exist: $SOURCE_DIR" >&2
  exit 1
fi

CONTAINER_ID="$(docker compose ps -q "$SERVICE_NAME")"
if [ -z "$CONTAINER_ID" ]; then
  echo "Service '$SERVICE_NAME' is not running. Start it with: docker compose up -d" >&2
  exit 1
fi

echo "Preparing destination: $DEST_DIR"
docker compose exec -T "$SERVICE_NAME" sh -lc "mkdir -p '$DEST_DIR'"

if [ "$WIPE_DEST" -eq 1 ]; then
  echo "Wiping existing destination contents..."
  docker compose exec -T "$SERVICE_NAME" sh -lc "find '$DEST_DIR' -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
fi

echo "Copying profile from '$SOURCE_DIR' to container '$SERVICE_NAME:$DEST_DIR'..."
if [ "$VERBOSE" -eq 1 ]; then
  tar -C "$SOURCE_DIR" -cvf - . | docker compose exec -T "$SERVICE_NAME" sh -lc "tar -C '$DEST_DIR' -xvf -"
elif [ "$PROGRESS" -eq 1 ]; then
  set -- $(du -sm "$SOURCE_DIR" 2>/dev/null || echo 0 .)
  SOURCE_MB="${1:-0}"

  tar -C "$SOURCE_DIR" -cf - . | docker compose exec -T "$SERVICE_NAME" sh -lc "tar -C '$DEST_DIR' -xf -" &
  COPY_PID=$!

  while kill -0 "$COPY_PID" 2>/dev/null; do
    DEST_LINE="$(docker compose exec -T "$SERVICE_NAME" sh -lc "du -sm '$DEST_DIR' 2>/dev/null || echo 0 '$DEST_DIR'" 2>/dev/null || true)"
    set -- $DEST_LINE
    DEST_MB="${1:-0}"

    if [ "$SOURCE_MB" -gt 0 ] 2>/dev/null; then
      PCT=$((DEST_MB * 100 / SOURCE_MB))
      if [ "$PCT" -gt 100 ]; then
        PCT=100
      fi
      echo "Progress: ${DEST_MB}MB / ${SOURCE_MB}MB (${PCT}%)"
    else
      echo "Progress: ${DEST_MB}MB copied"
    fi

    sleep 3
  done

  wait "$COPY_PID"
else
  tar -C "$SOURCE_DIR" -cf - . | docker compose exec -T "$SERVICE_NAME" sh -lc "tar -C '$DEST_DIR' -xf -"
fi

echo "Done. Imported profile into $DEST_DIR"
