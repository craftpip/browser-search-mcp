#!/usr/bin/env bash
set -euo pipefail

if [ "${ENABLE_VNC:-0}" = "1" ]; then
  export DISPLAY="${DISPLAY:-:99}"

  display_num="${DISPLAY#:}"
  lock_file="/tmp/.X${display_num}-lock"
  socket_file="/tmp/.X11-unix/X${display_num}"

  if [ -f "$lock_file" ]; then
    lock_pid="$(cat "$lock_file" 2>/dev/null || true)"
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      echo "Xvfb already running on display $DISPLAY (pid $lock_pid), reusing it"
    else
      rm -f "$lock_file" "$socket_file"
    fi
  fi

  if ! pgrep -f "Xvfb $DISPLAY" >/dev/null 2>&1; then
    Xvfb "$DISPLAY" -screen 0 "${XVFB_WHD:-1920x1080x24}" -ac +extension RANDR &
  fi
  for i in $(seq 1 50); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  fluxbox >/tmp/fluxbox.log 2>&1 &
  x11vnc -display "$DISPLAY" -rfbport "${VNC_PORT:-5900}" -forever -shared -nopw >/tmp/x11vnc.log 2>&1 &
  websockify --web=/usr/share/novnc/ "${NOVNC_PORT:-7900}" "localhost:${VNC_PORT:-5900}" >/tmp/novnc.log 2>&1 &
fi

exec "$@"
