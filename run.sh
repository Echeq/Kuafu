#!/usr/bin/env bash
# Launch Kuafu (unofficial Quark Cloud client).
# Finds Electron: system package first (electron43/electron), then a local
# install under node_modules. This keeps the project exportable to any machine
# that has either one.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

find_electron() {
  for bin in electron43 electron electron39 electron38 electron37 electron36; do
    if command -v "$bin" >/dev/null 2>&1; then
      printf '%s\n' "$bin"
      return 0
    fi
  done
  for local in ./node_modules/.bin/electron ./node_modules/electron/dist/electron; do
    if [[ -x $local ]]; then
      printf '%s\n' "$PWD/${local#./}"
      return 0
    fi
  done
  return 1
}

if ! ELECTRON_BIN=$(find_electron); then
  cat >&2 <<'EOF'
Error: Electron not found.
  Option A) Install it from your distro:   Arch: sudo pacman -S electron   |   Omarchy: omarchy pkg add electron43
  Option B) Install it locally in this project:  npm install
  Full guide for all distributions: see INSTALL.md
EOF
  exit 1
fi

exec "$ELECTRON_BIN" \
  --ozone-platform-hint=auto \
  --enable-wayland-ime \
  --wayland-text-input-version=3 \
  --class=quark-cloud \
  "$PWD" "$@"
