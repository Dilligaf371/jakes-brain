#!/usr/bin/env bash
# Jake's Brain on the PC: open the web app in a chromeless browser window (Chromium --app= mode).
#
#   deploy/desktop/open.sh                 the home screen  -> http://localhost:4800/#/
#   deploy/desktop/open.sh graph           a route          -> http://localhost:4800/#/graph
#   deploy/desktop/open.sh '#/notes/42'    a hash, a /path or a full http(s) URL also work
#   deploy/desktop/open.sh --print [route] only print the command it would run (nothing opens)
#
# Works from a terminal inside the GNOME session and over ssh: when DISPLAY and
# WAYLAND_DISPLAY are both unset it imports them (plus XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS,
# XAUTHORITY) from `systemctl --user show-environment`, and the browser is detached
# (setsid / nohup, no tty) so the ssh session can exit while the window stays open.
#
# With no route given, an already-open JakesData window is focused instead of opening a
# second one (wmctrl or xdotool when present; otherwise the browser gets the URL again, which
# Chromium turns into another app window of the same profile). A route always opens.
#
# Browser: the first of google-chrome, google-chrome-stable, chromium, chromium-browser,
# brave-browser on PATH, in /snap/bin or among the flatpak exports; with none of those,
# a plain Firefox window (no app mode) and a note. Plain bash, no sudo.
#
# Env: JAKESDATA_BROWSER   path or name of the browser to use (skips the search)
#      JAKESDATA_PORT      the server's port (4800)
set -euo pipefail

PORT=${JAKESDATA_PORT:-4800}
PROFILE_DIR=${JAKESDATA_WINDOW_PROFILE:-$HOME/.config/jakes-data-app-window}
WM_CLASS=JakesData
WINDOW_SIZE=1280,860
PRINT=0
ROUTE=""

usage() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --print|--dry-run|-n) PRINT=1 ;;
    -h|--help) usage; exit 0 ;;
    --) ;;
    *) ROUTE=$arg ;;
  esac
done

# ---------------------------------------------------------------- url

case "$ROUTE" in
  http://*|https://*) URL=$ROUTE ;;
  *)
    r=${ROUTE#\#}   # '#/graph' -> '/graph'
    r=${r#/}        # '/graph'  -> 'graph'
    URL="http://localhost:$PORT/#/$r"
    ;;
esac

# ---------------------------------------------------------------- session environment (ssh)

# Inside the session DISPLAY / WAYLAND_DISPLAY are already set. Over ssh they are not: the
# GNOME session exported them to the user's systemd manager, so read them back from there.
import_session_env() {
  if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then return 0; fi
  if command -v systemctl >/dev/null 2>&1; then
    local line key value
    while IFS= read -r line; do
      key=${line%%=*}
      value=${line#*=}
      case "$key" in
        DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|XAUTHORITY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP)
          # systemd shell-quotes values that need it
          value=${value#\'}; value=${value%\'}
          value=${value#\"}; value=${value%\"}
          if [ -z "${!key:-}" ]; then export "$key=$value"; fi
          ;;
      esac
    done < <(systemctl --user show-environment 2>/dev/null || true)
  fi
  : "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
  : "${DBUS_SESSION_BUS_ADDRESS:=unix:path=$XDG_RUNTIME_DIR/bus}"
  export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
  # Last resort (the user manager had nothing): the values of the PC's GNOME session.
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    export DISPLAY=:0 WAYLAND_DISPLAY=wayland-0
  fi
}

# ---------------------------------------------------------------- browser

flatpak_dirs() {
  printf '%s\n' "$HOME/.local/share/flatpak/exports/bin" /var/lib/flatpak/exports/bin
}

# Prints the path of the first Chromium-based browser found; exit 1 when there is none.
find_chromium() {
  local name candidate dir
  if [ -n "${JAKESDATA_BROWSER:-}" ]; then
    if [ -x "$JAKESDATA_BROWSER" ] && [ ! -d "$JAKESDATA_BROWSER" ]; then
      printf '%s\n' "$JAKESDATA_BROWSER"
      return 0
    fi
    if candidate=$(command -v "$JAKESDATA_BROWSER" 2>/dev/null); then
      printf '%s\n' "$candidate"
      return 0
    fi
    echo "open.sh: JAKESDATA_BROWSER=$JAKESDATA_BROWSER is not an executable" >&2
    return 2
  fi
  for name in google-chrome google-chrome-stable chromium chromium-browser brave-browser; do
    if candidate=$(command -v "$name" 2>/dev/null); then
      printf '%s\n' "$candidate"
      return 0
    fi
    if [ -x "/snap/bin/$name" ]; then
      printf '%s\n' "/snap/bin/$name"
      return 0
    fi
  done
  for name in com.google.Chrome org.chromium.Chromium com.brave.Browser; do
    while IFS= read -r dir; do
      candidate=$dir/$name
      if [ -x "$candidate" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done < <(flatpak_dirs)
  done
  return 1
}

find_firefox() {
  local candidate dir
  if candidate=$(command -v firefox 2>/dev/null); then
    printf '%s\n' "$candidate"
    return 0
  fi
  if [ -x /snap/bin/firefox ]; then
    printf '%s\n' /snap/bin/firefox
    return 0
  fi
  while IFS= read -r dir; do
    if [ -x "$dir/org.mozilla.firefox" ]; then
      printf '%s\n' "$dir/org.mozilla.firefox"
      return 0
    fi
  done < <(flatpak_dirs)
  return 1
}

KIND=""
BROWSER=""
if BROWSER=$(find_chromium); then
  KIND=chromium
else
  status=$?
  if [ "$status" = 2 ]; then exit 2; fi
  if BROWSER=$(find_firefox); then
    KIND=firefox
  else
    echo "open.sh: no browser found (looked for google-chrome, google-chrome-stable, chromium, chromium-browser, brave-browser, firefox)" >&2
    exit 1
  fi
fi

if [ "$KIND" = chromium ]; then
  CMD=("$BROWSER" "--app=$URL" "--class=$WM_CLASS" "--user-data-dir=$PROFILE_DIR" "--window-size=$WINDOW_SIZE" --no-first-run --no-default-browser-check)
else
  CMD=("$BROWSER" --new-window "$URL")
fi

# ---------------------------------------------------------------- focus an open window

# True when a JakesData window exists AND we managed to raise it. Only X11/XWayland windows
# are visible to wmctrl/xdotool; on pure Wayland this quietly fails and we open instead.
focus_existing() {
  [ "$KIND" = chromium ] || return 1
  if command -v wmctrl >/dev/null 2>&1; then
    if wmctrl -lx 2>/dev/null | awk '{ print $3 }' | grep -qi "$WM_CLASS"; then
      wmctrl -x -a "$WM_CLASS" >/dev/null 2>&1 && return 0
    fi
  fi
  if command -v xdotool >/dev/null 2>&1; then
    local wid
    wid=$(xdotool search --class "$WM_CLASS" 2>/dev/null | head -n 1 || true)
    if [ -n "$wid" ]; then
      xdotool windowactivate "$wid" >/dev/null 2>&1 && return 0
    fi
  fi
  return 1
}

# ---------------------------------------------------------------- go

import_session_env

if [ "$PRINT" = 1 ]; then
  if [ "$KIND" = firefox ]; then
    echo "open.sh: no Chromium-based browser found; this would be a plain Firefox window (no app mode)" >&2
  fi
  printf '%q ' "${CMD[@]}"
  printf '\n'
  exit 0
fi

if [ -z "$ROUTE" ] && focus_existing; then
  exit 0
fi

if [ "$KIND" = firefox ]; then
  echo "open.sh: no Chromium-based browser found; opening a plain Firefox window instead (no app mode). Install chromium or brave-browser for a proper app window." >&2
fi

# Detach: a new session, no tty, no inherited stdio, so an ssh session can exit at once.
if command -v setsid >/dev/null 2>&1; then
  setsid -f "${CMD[@]}" >/dev/null 2>&1 </dev/null
else
  nohup "${CMD[@]}" >/dev/null 2>&1 </dev/null &
  disown 2>/dev/null || true
fi
