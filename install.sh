#!/usr/bin/env bash
# Install Kuafu on the desktop (launcher + icon) pointing at THIS folder.
# Exporting the project = copy the folder and run this script on the target.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
DESKTOP_FILE="$DESKTOP_DIR/Kuafu.desktop"

chmod +x "$APP_DIR/run.sh" "$APP_DIR/install.sh" "$APP_DIR/uninstall.sh" "$APP_DIR/package.sh" 2>/dev/null || true

mkdir -p "$DESKTOP_DIR" "$ICON_DIR"
cp "$APP_DIR/assets/quark-cloud-256.png" "$ICON_DIR/quark-cloud.png"
# Older versions used different entry names; drop them so only one entry shows up.
rm -f "$DESKTOP_DIR/QuarkCloud for Linux.desktop"
rm -f "$DESKTOP_DIR/Quark Cloud.desktop"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Version=1.0
Name=Kuafu
Comment=Unofficial desktop client for Quark Cloud（夸克网盘非官方桌面客户端）
Exec="$APP_DIR/run.sh"
Terminal=false
Type=Application
Icon=quark-cloud
StartupNotify=true
StartupWMClass=quark-cloud
Categories=Network;FileTransfer;
Keywords=kuafu;quark;pan;cloud;drive;网盘;夸克;夸父;
EOF
chmod +x "$DESKTOP_FILE"

gtk-update-icon-cache "$HOME/.local/share/icons/hicolor" &>/dev/null || true
update-desktop-database "$DESKTOP_DIR" &>/dev/null || true

echo "✓ Kuafu installed"
echo "  Launcher: $DESKTOP_FILE"
echo "  Icon:     $ICON_DIR/quark-cloud.png"
echo "  App:      $APP_DIR/run.sh"
echo
echo "Open it with SUPER + SPACE → \"Kuafu\". To uninstall: bash $APP_DIR/uninstall.sh"
