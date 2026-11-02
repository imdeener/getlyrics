#!/bin/sh
# Builds getlyrics-<version>.zip with only the files the extension loads.
set -e
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="getlyrics-$version.zip"
rm -f "$out"
zip -qr "$out" manifest.json background.js content.js parse.js content.css _locales icons -x '.*'
echo "$out"
