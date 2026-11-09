#!/usr/bin/env bash
# Builds two zips in dist/:
#   ai-sanitizer-extension-vX.zip   runtime files only: unzip and "Load unpacked" (or upload to the Web Store)
#   ai-sanitizer-source-vX.zip      the whole project: tests, tools, e2e harness (no node_modules)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./manifest.json').version")"
mkdir -p dist
rm -f dist/*.zip

zip -r -q "dist/ai-sanitizer-extension-v${VERSION}.zip" \
  manifest.json README.md src \
  icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png \
  -x '*.DS_Store'

zip -r -q "dist/ai-sanitizer-source-v${VERSION}.zip" . \
  -x 'node_modules/*' 'dist/*' '.git/*' '*.DS_Store'

ls -l dist/*.zip
