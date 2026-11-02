#!/usr/bin/env bash
# Run ON THE PC. Installs the GNOME launcher entry for Jake's Brain for this user (no sudo):
#   ~/.local/share/applications/jakes-data.desktop   (with <home> expanded)
#   ~/.local/share/icons/hicolor/512x512/apps/jakes-data.png
# then refreshes the desktop database and icon cache when those tools exist and says how to
# pin it to the dash. Safe to re-run.
#
#   deploy/desktop/install-desktop.sh           install
#   deploy/desktop/install-desktop.sh --pin     install and pin it to the dash (gsettings)
#   deploy/desktop/install-desktop.sh --print   show what would be written; writes nothing
#
# Honours XDG_DATA_HOME (default ~/.local/share).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
APPS_DIR=$DATA_HOME/applications
ICON_DIR=$DATA_HOME/icons/hicolor/512x512/apps
SRC_DESKTOP=$HERE/jakes-data.desktop
SRC_ICON=$REPO/web/icons/icon-512.png
DESKTOP_ID=jakes-data.desktop
PRINT=0
PIN=0

for arg in "$@"; do
  case "$arg" in
    --print|--dry-run|-n) PRINT=1 ;;
    --pin) PIN=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install-desktop.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != Linux ] && [ -z "${XDG_DATA_HOME:-}" ] && [ "$PRINT" = 0 ]; then
  echo "install-desktop.sh: this installs a GNOME launcher entry; run it on the PC (ssh pcserver, then ~/jakes-data-app/deploy/desktop/install-desktop.sh)." >&2
  exit 1
fi

[ -f "$SRC_DESKTOP" ] || { echo "install-desktop.sh: missing $SRC_DESKTOP" >&2; exit 1; }
[ -f "$SRC_ICON" ] || { echo "install-desktop.sh: missing $SRC_ICON" >&2; exit 1; }
chmod +x "$HERE/open.sh" 2>/dev/null || true

# The .desktop file points at <home>/jakes-data-app/deploy/desktop/open.sh. When the repo
# is somewhere else, point at the real open.sh next to this script instead.
OPEN_SH=$HOME/jakes-data-app/deploy/desktop/open.sh
[ -x "$OPEN_SH" ] || OPEN_SH=$HERE/open.sh
OPEN_SH_VALUE=$OPEN_SH
case "$OPEN_SH" in *[[:space:]]*) OPEN_SH_VALUE="\"$OPEN_SH\"" ;; esac

# Expand the placeholders. Paths go through awk -v (no sed delimiter trouble with odd paths).
render() {
  awk -v open="$OPEN_SH_VALUE" -v home="$HOME" '{
    gsub(/<home>\/jakes-data-app\/deploy\/desktop\/open\.sh/, open)
    gsub(/<home>/, home)
    print
  }' "$SRC_DESKTOP"
}

if [ "$PRINT" = 1 ]; then
  echo "would write $APPS_DIR/$DESKTOP_ID:"
  render | sed 's/^/    /'
  echo "would copy  $SRC_ICON -> $ICON_DIR/jakes-data.png"
  exit 0
fi

mkdir -p "$APPS_DIR" "$ICON_DIR"
render > "$APPS_DIR/$DESKTOP_ID"
chmod 644 "$APPS_DIR/$DESKTOP_ID"
cp "$SRC_ICON" "$ICON_DIR/jakes-data.png"
chmod 644 "$ICON_DIR/jakes-data.png"
echo "wrote $APPS_DIR/$DESKTOP_ID"
echo "wrote $ICON_DIR/jakes-data.png"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" 2>/dev/null && echo "updated the desktop database" || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  # Optional: GNOME finds icons under ~/.local/share/icons without a cache; -q hides the
  # "no theme index" complaint a bare hicolor tree gives.
  gtk-update-icon-cache -q -f -t "$DATA_HOME/icons/hicolor" 2>/dev/null && echo "updated the icon cache" || true
fi
if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$APPS_DIR/$DESKTOP_ID" || echo "(desktop-file-validate had complaints; the entry still works)"
fi

# Pinning edits org.gnome.shell favorite-apps, which needs the session bus (over ssh it is
# not in the environment; the user bus has a fixed path).
pin_to_dash() {
  if ! command -v gsettings >/dev/null 2>&1; then
    echo "gsettings not found; pin it by hand (see below)."
    return 0
  fi
  : "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
  : "${DBUS_SESSION_BUS_ADDRESS:=unix:path=$XDG_RUNTIME_DIR/bus}"
  export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
  local current next
  if ! current=$(gsettings get org.gnome.shell favorite-apps 2>/dev/null); then
    echo "could not read the dash favourites; pin it by hand (see below)."
    return 0
  fi
  case "$current" in
    *"'$DESKTOP_ID'"*) echo "already pinned to the dash."; return 0 ;;
  esac
  current=${current#@as }
  case "$current" in
    "[]") next="['$DESKTOP_ID']" ;;
    *) next="${current%]}, '$DESKTOP_ID']" ;;
  esac
  if gsettings set org.gnome.shell favorite-apps "$next"; then
    echo "pinned to the dash."
  else
    echo "could not pin it; pin it by hand (see below)."
  fi
}

if [ "$PIN" = 1 ]; then pin_to_dash; fi

cat <<EOF

Installed. Press Super, type "Jake's Brain" and press Enter to open it (or run
$OPEN_SH graph for a route). Right-click its icon in the dash for Graph / Notes / JakeGPT.
To pin it to the dash: open it, right-click its icon in the dash -> "Pin to Dash",
or run: $HERE/install-desktop.sh --pin
EOF
