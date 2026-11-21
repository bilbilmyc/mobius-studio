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
pid=
attached=false
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
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
codesign --verify --strict --deep --verbose=2 "$app"
export MOBIUS_HOME="$work/Data" MOBIUS_SMOKE_TEST=1
"$binary" >"$work/launch.log" 2>&1 &
pid=$!
for ((i=0; i<60; i++)); do
  if grep -q 'MOBIUS_WEBVIEW_READY' "$work/launch.log"; then break; fi
  if ! kill -0 "$pid" 2>/dev/null; then cat "$work/launch.log"; exit 1; fi
  sleep 1
done
test -f "$MOBIUS_HOME/.studio.lock"
grep -Fx MOBIUS_WEBVIEW_READY "$work/launch.log"
kill -0 "$pid"
shasum -a 256 "${images[0]}"
