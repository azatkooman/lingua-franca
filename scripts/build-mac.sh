#!/bin/bash
#
# Build a macOS release.
#
# electron-builder skips signing when no Developer ID is installed, and an unsigned arm64
# bundle will not launch at all — macOS refuses it outright. So the app is packaged first,
# signed second, and only then wrapped in a DMG. Building the DMG in one pass would seal an
# unsigned app inside it.
#
# With a real "Developer ID Application" identity in the keychain this uses it automatically;
# otherwise it falls back to an ad-hoc signature, which is fine for local use and for sharing
# with someone willing to right-click → Open, but is not notarised.
#
#   npm run electron:build:mac
#
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${LINGUA_FRANCA_ARCH:-$(uname -m)}"
case "$ARCH" in
  arm64) BUILDER_ARCH="--arm64" ;;
  x86_64) BUILDER_ARCH="--x64"; ARCH="x64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

APP_DIR="release/mac-$( [ "$ARCH" = "arm64" ] && echo arm64 || echo x64 )"
APP="$APP_DIR/Lingua Franca.app"
ENT="desktop/entitlements.mac.plist"
ENT_INHERIT="desktop/entitlements.mac.inherit.plist"

echo "==> Building the renderer"
npm run build

echo "==> Packaging the app bundle ($ARCH)"
npx electron-builder --mac --dir "$BUILDER_ARCH"

IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | head -1 | sed -E 's/.*"(.*)"/\1/' || true)
if [ -n "$IDENTITY" ]; then
  echo "==> Signing with: $IDENTITY"
  SIGN_AS="$IDENTITY"
else
  echo "==> No Developer ID found; signing ad-hoc (not notarised)"
  SIGN_AS="-"
fi

echo "==> Signing inside-out"
# --deep covers the Electron framework, the helper apps and the crashpad handler.
codesign --force --deep --sign "$SIGN_AS" "$APP"
# The mediasoup worker is a child process launched from Resources, outside the usual
# Contents/MacOS layout, so it is signed explicitly with the inherited entitlements.
codesign --force --options runtime --entitlements "$ENT_INHERIT" \
  --sign "$SIGN_AS" "$APP/Contents/Resources/bin/mediasoup-worker"
# Re-seal the bundle last so the nested signatures above are captured in its seal.
codesign --force --options runtime --entitlements "$ENT" --sign "$SIGN_AS" "$APP"

echo "==> Verifying"
codesign --verify --deep --strict --verbose=1 "$APP"

echo "==> Building the DMG from the signed bundle"
npx electron-builder --mac dmg "$BUILDER_ARCH" --prepackaged "$APP"

echo
echo "Done:"
ls -lh release/*.dmg
