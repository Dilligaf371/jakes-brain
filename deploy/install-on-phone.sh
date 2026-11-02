#!/usr/bin/env bash
# Build Jake's Data signed with Jake's team and install it on his iPhone (USB or same-WiFi, unlocked).
# A development install from a paid team lasts 1 year. Re-run after any ios/ change.
set -euo pipefail
cd "$(dirname "$0")/../ios"
UDID=${JAKESDATA_DEVICE_UDID:-00008150-00062DD41408401C}
xcodegen generate >/dev/null
xcodebuild -project JakesData.xcodeproj -scheme JakesData -configuration Release -destination "generic/platform=iOS" \
  -derivedDataPath build -allowProvisioningUpdates -allowProvisioningDeviceRegistration build -quiet
APP=build/Build/Products/Release-iphoneos/JakesData.app
xcrun devicectl device install app --device "$UDID" "$APP"
xcrun devicectl device process launch --device "$UDID" com.jakebeau.jakesdata || true
echo "installed on iPhone ($UDID)"
