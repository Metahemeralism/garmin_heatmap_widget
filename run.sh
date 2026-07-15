#!/bin/sh
# run.sh — launchd entry point for the Garmin heatmap fetcher.
#
# Why this wrapper exists: credentials are kept in the macOS Keychain, never in
# the launchd plist (a plist is world-readable plain text). This script pulls them
# from the Keychain at runtime, only into its own short-lived environment, then
# runs the fetcher. After the first login, tokens are cached and the fetcher
# resumes without needing the password at all.
#
# Keychain items (service = "garmin_heatmap"), created by install.sh:
#   account "email"   -> your Garmin login email
#   account "<email>" -> your Garmin password
set -eu

HOME_DIR="$HOME/.garmin_heatmap"

GARMIN_EMAIL="$(security find-generic-password -s garmin_heatmap -a email -w 2>/dev/null || true)"
GARMIN_PASSWORD="$(security find-generic-password -s garmin_heatmap -a "$GARMIN_EMAIL" -w 2>/dev/null || true)"
export GARMIN_EMAIL GARMIN_PASSWORD

exec "$HOME_DIR/venv/bin/python3" "$HOME_DIR/garmin_fetch.py"
