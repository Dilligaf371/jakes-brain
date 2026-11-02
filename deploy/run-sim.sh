#!/usr/bin/env bash
# Build and launch Jake's Data in the booted iOS Simulator (boots "iPhone 17 Pro" if nothing is booted).
set -euo pipefail
cd "$(dirname "$0")/../ios"
xcodegen generate >/dev/null
BOOTED=$(xcrun simctl list devices booted -j | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next((x["udid"] for v in d["devices"].values() for x in v if x["state"]=="Booted"),""))')
if [ -z "$BOOTED" ]; then xcrun simctl boot "iPhone 17 Pro"; BOOTED=booted; fi
xcodebuild -project JakesData.xcodeproj -scheme Jake's Data -configuration Debug -sdk iphonesimulator \
  -destination "id=$BOOTED" -derivedDataPath build CODE_SIGNING_ALLOWED=NO build -quiet
APP=build/Build/Products/Debug-iphonesimulator/JakesData.app
xcrun simctl install "$BOOTED" "$APP"
xcrun simctl launch "$BOOTED" com.jakebeau.jakesdata
