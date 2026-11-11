#!/usr/bin/env bash
# ServerSherpa kiosk launcher (laptop edition), macOS and Linux.
#
# Run at sign-in (macOS launch agent com.serversherpa.kiosk.launch, Linux
# autostart serversherpa-kiosk.desktop) and from the ServerSherpa Kiosk app
# or menu entry. Waits for the kiosk to answer, then opens it in the browser
# the installer found (KIOSK_BROWSER in config.env), in app mode; when it found
# none, Chrome or Edge is looked for again, else the default browser opens.
#
# Linux: when kiosk_session.py is installed next to this script and python3 and
# a browser are there, the kiosk session takes over (kiosk_session.py: the
# waiting page, Chrome in --kiosk mode with a watcher, the desktop lock, the
# Esc → PIN exit). Otherwise, and on macOS always, the kiosk opens in an app
# window as before.
#
# Environment: KIOSK_LAUNCH_TIMEOUT_S (default 300), KIOSK_LAUNCH_POLL_S (2).
# Testing hooks: KIOSK_LAUNCH_LIB=1 defines the functions without running main.
# Written for bash 3.2 (macOS's bash).
set -uo pipefail

KIOSK_DIR="${KIOSK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
KIOSK_URL='http://localhost:8090'
KIOSK_LAUNCH_TIMEOUT_S="${KIOSK_LAUNCH_TIMEOUT_S:-300}"
KIOSK_LAUNCH_POLL_S="${KIOSK_LAUNCH_POLL_S:-2}"
OS=$(uname -s)

kiosk_answers() { curl -fsS --max-time 3 "$KIOSK_URL/edge/identity" >/dev/null 2>&1; }

# wait_for_kiosk: until /edge/identity answers or the timeout passes.
wait_for_kiosk() {
  local deadline=$((SECONDS + KIOSK_LAUNCH_TIMEOUT_S))
  until kiosk_answers; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "The kiosk didn't answer at $KIOSK_URL within $KIOSK_LAUNCH_TIMEOUT_S seconds; opening it anyway." >&2
      return 1
    fi
    sleep "$KIOSK_LAUNCH_POLL_S"
  done
}

# browser: KIOSK_BROWSER from config.env, read without executing the file.
browser() {
  local line=''
  [ -f "$KIOSK_DIR/config.env" ] || return 0
  line=$(grep -E '^KIOSK_BROWSER=' "$KIOSK_DIR/config.env" | head -n 1 || true)
  printf '%s' "${line#*=}"
}

# find_browser: Chrome, Chromium or Edge, in install.sh's order, for a
# station where none was installed when the kiosk was (empty when none).
MAC_APPS_DIR='/Applications'
find_browser() {
  local c
  if [ "$OS" = Darwin ]; then
    for c in "$MAC_APPS_DIR/Google Chrome.app" "$MAC_APPS_DIR/Microsoft Edge.app" "$MAC_APPS_DIR/Chromium.app"; do
      if [ -d "$c" ]; then printf '%s' "$c"; return 0; fi
    done
  else
    for c in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge; do
      if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
    done
  fi
  return 0
}

run_browser() { "$@" >/dev/null 2>&1 & }

open_kiosk() {
  local b
  b=$(browser)
  [ -n "$b" ] || b=$(find_browser)
  if [ "$OS" = Darwin ]; then
    if [ -n "$b" ]; then
      open -na "$b" --args --app="$KIOSK_URL"
    else
      open "$KIOSK_URL"
    fi
  elif [ -n "$b" ]; then
    run_browser "$b" --app="$KIOSK_URL"
  else
    xdg-open "$KIOSK_URL"
  fi
}

have_python3() { command -v python3 >/dev/null 2>&1; }
session_ready() { [ -f "$KIOSK_DIR/kiosk_session.py" ] && have_python3; }
# run_session BROWSER: the Linux kiosk session, as a child so a crash at startup
# (a bad nightly refresh) still leaves a way back. Returns its exit code.
run_session() { python3 "$KIOSK_DIR/kiosk_session.py" run --browser "$1"; }
# restore_session_desktop: the session can't start, so a desktop lock an
# earlier session left is put back (never leave the shortcuts off).
restore_session_desktop() { python3 "$KIOSK_DIR/kiosk_session.py" restore >/dev/null 2>&1 || true; }

main() {
  local b rc
  if [ "$OS" = Linux ] && session_ready; then
    b=$(browser)
    [ -n "$b" ] || b=$(find_browser)
    if [ -n "$b" ]; then
      rc=0
      run_session "$b" || rc=$?
      # 0 = a normal PIN exit to the desktop: nothing more to do.
      [ "$rc" -eq 0 ] && return 0
      # It crashed: put the desktop back, then the plain app window below.
    fi
    restore_session_desktop
  fi
  wait_for_kiosk || true
  open_kiosk
}

# Called on the last line so a partially written script runs nothing.
if [ "${KIOSK_LAUNCH_LIB:-0}" != "1" ]; then
  main "$@"
fi
