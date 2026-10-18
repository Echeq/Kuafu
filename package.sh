#!/usr/bin/env bash
# Package the project for export to another machine:
#   bash package.sh   -> dist/Kuafu-<version>.tar.gz
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)
VERSION=${VERSION:-1.0.0}

mkdir -p dist
tar --exclude=./dist --exclude=./node_modules --exclude=./.git \
  -czf "dist/Kuafu-${VERSION}.tar.gz" .

echo "✓ Created dist/Kuafu-${VERSION}.tar.gz"
echo "  On another machine: extract and run  bash install.sh"
