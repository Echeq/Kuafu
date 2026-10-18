#!/usr/bin/env bash
# Remove the Kuafu launcher and icon.
#   bash uninstall.sh            -> keeps the app session (cookies/login)
#   bash uninstall.sh --purge    -> also deletes app data (cookies/login)
set -euo pipefail

DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"

rm -f "$DESKTOP_DIR/Kuafu.desktop"
rm -f "$DESKTOP_DIR/QuarkCloud for Linux.desktop"   # entry name used by version 1.1.x
rm -f "$DESKTOP_DIR/Quark Cloud.desktop"            # entry name used by versions ≤ 1.0.x
rm -f "$ICON_DIR/quark-cloud.png"
gtk-update-icon-cache "$HOME/.local/share/icons/hicolor" &>/dev/null || true
update-desktop-database "$DESKTOP_DIR" &>/dev/null || true

if [[ ${1:-} == "--purge" ]]; then
  rm -rf "$HOME/.config/quark-cloud"
  echo "✓ App data deleted (cookies/settings)"
fi

echo "✓ Kuafu removed from the desktop (the project folder is untouched)"
