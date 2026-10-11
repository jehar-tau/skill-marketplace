#!/bin/sh
# Builds an installable Android APK without Android Studio.
# Needs: brew install openjdk@17 && brew install --cask android-commandlinetools
# Usage: pnpm build:apk [server-address]
#   server-address defaults to this Mac's address on the current Wi-Fi.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
API_URL="${1:-http://$IP:4000}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export PATH="$JAVA_HOME/bin:$PATH"
export EXPO_PUBLIC_API_URL="$API_URL"
export NODE_ENV=production

echo "Building for server: $API_URL"
yes | sdkmanager --licenses >/dev/null 2>&1 || true
cd "$ROOT/apps/mobile"
npx expo prebuild --platform android
cd android
# arm64 only: every Android phone sold in the last several years. Keeps the build and the file small.
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --console=plain
cp app/build/outputs/apk/release/app-release.apk "$ROOT/SkillMarketplace.apk"
echo "Done: $ROOT/SkillMarketplace.apk"
