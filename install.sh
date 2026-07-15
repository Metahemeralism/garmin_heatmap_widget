#!/bin/bash
# install.sh — one-shot setup for the Garmin performance heatmap widget.
#
# Does everything the README describes, in order:
#   1. creates ~/.garmin_heatmap, a venv, and installs deps
#   2. stores your Garmin email + password in the macOS Keychain (NOT in any file)
#   3. installs the Übersicht widget
#   4. installs + loads a twice-daily launchd job
#   5. runs the first fetch (pulls ~1 year; may take a few minutes)
#
# Safe to re-run: it updates in place and won't duplicate anything.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"     # repo directory this script lives in
DATA_DIR="$HOME/.garmin_heatmap"
WIDGET_DIR="$HOME/Library/Application Support/Übersicht/widgets/garmin-heatmap.widget"
PLIST="$HOME/Library/LaunchAgents/com.garmin.heatmap.plist"
LABEL="com.garmin.heatmap"

echo "==> 1/5  Python environment"
mkdir -p "$DATA_DIR"
cp "$SRC/garmin_fetch.py" "$DATA_DIR/garmin_fetch.py"
cp "$SRC/run.sh" "$DATA_DIR/run.sh"
chmod +x "$DATA_DIR/run.sh"
if [ ! -x "$DATA_DIR/venv/bin/python3" ]; then
  python3 -m venv "$DATA_DIR/venv"
fi
"$DATA_DIR/venv/bin/python3" -m pip install --quiet --upgrade pip
"$DATA_DIR/venv/bin/pip" install --quiet garminconnect curl_cffi ua-generator
echo "    deps installed"

echo "==> 2/5  Garmin credentials -> Keychain"
if security find-generic-password -s garmin_heatmap -a email -w >/dev/null 2>&1; then
  echo "    Keychain items already present (skipping; delete them to re-enter)"
else
  read -r -p "    Garmin email: " GEMAIL
  # -T authorizes /usr/bin/security to read these without a GUI prompt from launchd.
  security add-generic-password -U -s garmin_heatmap -a email -T /usr/bin/security -w "$GEMAIL"
  echo "    Garmin password (typed hidden; you'll be asked to confirm):"
  security add-generic-password -U -s garmin_heatmap -a "$GEMAIL" -T /usr/bin/security -w
  echo "    stored"
fi

echo "==> 3/5  Übersicht widget"
if [ ! -d "/Applications/Übersicht.app" ]; then
  echo "    !! Übersicht is not in /Applications."
  echo "       Install it from https://tracesof.net/uebersicht/ then re-run, or"
  echo "       continue — the fetcher/launchd still work; the widget just won't draw."
fi
mkdir -p "$WIDGET_DIR"
cp "$SRC/index.jsx" "$WIDGET_DIR/index.jsx"
echo "    widget placed"

echo "==> 4/5  launchd job (twice daily)"
sed "s|__HOME__|$HOME|g" "$SRC/com.garmin.heatmap.plist.template" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "    loaded $LABEL"

echo "==> 5/5  First fetch (this pulls ~1 year and may take a few minutes)"
GARMIN_EMAIL="$(security find-generic-password -s garmin_heatmap -a email -w)"
GARMIN_PASSWORD="$(security find-generic-password -s garmin_heatmap -a "$GARMIN_EMAIL" -w)"
export GARMIN_EMAIL GARMIN_PASSWORD
"$DATA_DIR/venv/bin/python3" "$DATA_DIR/garmin_fetch.py" || {
  echo "    first fetch failed — check the message above (rate limit? wrong password?)."
  echo "    You can re-run just the fetch with:  $DATA_DIR/run.sh"
  exit 1
}

echo
echo "Done. If the widget isn't visible, grant Übersicht Screen Recording permission"
echo "(System Settings -> Privacy & Security -> Screen Recording), then reopen it."
