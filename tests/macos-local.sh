#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo '请在 M 系列 Mac 的原生终端运行这项测试。' >&2
  exit 1
fi
export MACOSX_DEPLOYMENT_TARGET=13.0
npm ci
npm run typecheck
npm run installer -- --arch=arm64
bash tests/macos-dmg.sh
npm run build
cargo test --locked --release --features custom-protocol,installed --manifest-path src-tauri/Cargo.toml
npm run test:render -- --require-gpu --report=dist/macOS-render-4k.json
