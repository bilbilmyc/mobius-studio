#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob
images=(dist/Mobius-macOS-arm64-*.dmg)
[[ ${#images[@]} == 1 && $(uname -m) == arm64 ]]
hdiutil verify "${images[0]}"
work=$(mktemp -d)
mounted="$work/volume"
app="$work/Applications/莫比环.app"
mkdir -p "$mounted" "$work/Applications"
attached=false
cleanup() {
  if [[ "$attached" == true ]]; then hdiutil detach "$mounted"; fi
}
trap cleanup EXIT
hdiutil attach "${images[0]}" -readonly -nobrowse -mountpoint "$mounted"
attached=true
ditto "$mounted/莫比环.app" "$app"
hdiutil detach "$mounted"
attached=false
plist="$app/Contents/Info.plist"
binary="$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$plist")"
[[ $(lipo -archs "$binary") == arm64 ]]
[[ $(/usr/libexec/PlistBuddy -c 'Print LSMinimumSystemVersion' "$plist") == 13.0 ]]
minos=$(xcrun vtool -show-build "$binary" | awk '$1 == "minos" {print $2}')
[[ "$minos" == 13.0 || "$minos" == 13.0.0 ]]
codesign --verify --strict --deep --verbose=2 "$app"
node tests/macos-installed.mjs "$binary" "$work/Data"
shasum -a 256 "${images[0]}"
