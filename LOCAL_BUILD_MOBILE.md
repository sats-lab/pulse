# Local Mobile Builds on a Personal Apple Team

Use this guide to build, sign, install, and refresh the iOS Release app locally without EAS, App Store Connect, TestFlight, or a paid Apple Developer Program membership.

This document is for both the repository owner and coding agents operating on the owner's Mac. It focuses on a self-contained **Release** build for a physical iPhone. The installed app does not need Metro.

## Personal Team limitations

A free Apple Personal Team normally creates development provisioning profiles that are valid for approximately **7 days**. When the profile expires, iOS may refuse to launch the app. Rebuild, re-sign, and reinstall the app with the same bundle identifier to refresh it.

Other Personal Team restrictions include:

- No App Store or TestFlight distribution.
- No normal push-notification entitlement.
- No Sign in with Apple entitlement.
- No Associated Domains entitlement.
- No App Groups, widget extension, or share extension signing.
- A limited number of registered devices and app identifiers.

The repository's Personal Team mode removes those unsupported capabilities. A Personal Team `Release` configuration is still development-signed; it is not an App Store distribution build.

Installing a rebuilt app over the same bundle identifier normally preserves its application data. Do not uninstall the app unless a clean installation is intentionally required. Keep important connection or project information backed up rather than relying solely on the device container.

## Release and development apps side by side

Always use different bundle identifiers:

```text
Release: com.example.t3code
Dev:     com.example.t3code.dev
```

If Release and Dev use the same bundle identifier, installing one replaces the other. The app names alone do not provide isolation; iOS identifies an installation by its bundle identifier.

For the repository owner's current Personal Team setup, the identifiers are:

```text
Release: com.chanyeinthaw.t3code
Dev:     com.chanyeinthaw.t3code.dev
Team:    G6B453LQLF
```

Do not copy those values for another Apple account. Choose identifiers owned by that account and use its Team ID.

## Prerequisites

Use an Apple Silicon or Intel Mac with:

- A current Xcode installation.
- Xcode command-line tools selected:

  ```bash
  xcode-select -p
  xcodebuild -version
  ```

- The Apple ID added under **Xcode → Settings → Accounts**.
- A Personal Team visible in Xcode.
- An Apple Development signing certificate managed by Xcode.
- The iPhone paired with the Mac, trusted, and in Developer Mode.
- CocoaPods available as `pod`.
- The repository's locked dependencies installed.

From the repository root:

```bash
vp install --frozen-lockfile
eval "$(vp env print)"
node --version
pod --version
```

If CocoaPods is not installed, use a normal local installation appropriate for the Mac, for example:

```bash
brew install cocoapods
```

Do not give an agent a keychain password or Mac login password. If a remotely invoked build cannot access the signing identity, the agent should launch the build through the logged-in Mac's GUI Terminal session instead of requesting secrets.

## Find the Team ID and device ID

### Team ID

The Team ID is shown in Xcode's account/team details. It is also present in an existing signed application:

```bash
codesign -dv --verbose=2 /path/to/T3Code.app 2>&1 | grep TeamIdentifier
```

Use the 10-character value as `T3CODE_IOS_PERSONAL_TEAM_ID` and `DEVELOPMENT_TEAM`.

### Physical-device identifiers

The explicit workflow uses two identifiers because Xcode and `devicectl` can display different IDs for the same phone.

List Xcode-visible devices and note the physical device's UDID:

```bash
xcrun xctrace list devices
```

Use that value as `XCODE_DEVICE_ID` for the `xcodebuild -destination` argument. A physical-device UDID commonly resembles `00008150-...`. After prebuild, `xcodebuild -workspace apps/mobile/ios/T3Code.xcworkspace -scheme T3Code -showdestinations` can confirm that the generated project sees it.

List CoreDevice devices and note the matching device's identifier:

```bash
xcrun devicectl list devices
```

Use that value as `CORE_DEVICE_ID` for `devicectl` installation and launch commands. It commonly resembles a UUID. Confirm both entries refer to the intended phone.

## Quick interactive Release build

For routine owner-driven builds, start from the repository root and set values for the Apple account:

```bash
export T3CODE_IOS_PERSONAL_TEAM=1
export T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code
export T3CODE_IOS_PERSONAL_TEAM_ID=YOUR_TEAM_ID

cd apps/mobile
vp run ios:release
```

This performs a clean Expo prebuild, builds the production variant in Xcode's `Release` configuration, embeds the JavaScript bundle, and installs through Expo's local iOS runner. Select the intended physical device if prompted.

Use the explicit workflow below when diagnosing signing, controlling the output location, building through an agent, or ensuring the exact artifact is installed.

## Explicit reproducible Release workflow

Run these commands from the repository root. Replace all example values first:

```bash
export ROOT="$PWD"
export TEAM_ID="YOUR_TEAM_ID"
export BUNDLE_ID="com.example.t3code"
export XCODE_DEVICE_ID="YOUR_XCODE_DEVICE_UDID"
export CORE_DEVICE_ID="YOUR_COREDEVICE_ID"
export DERIVED_DATA="$ROOT/release/ios-personal-release/DerivedData"

export APP_VARIANT=production
export T3CODE_IOS_PERSONAL_TEAM=1
export T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID="$BUNDLE_ID"
export T3CODE_IOS_PERSONAL_TEAM_ID="$TEAM_ID"
export EXPO_NO_GIT_STATUS=1

eval "$(vp env print)"
```

All disposable build output is placed under ignored `release/`.

### 1. Generate the reduced-capability native project

```bash
cd "$ROOT/apps/mobile"
vp exec expo prebuild --platform ios --clean --no-install
```

The expected production workspace and scheme are:

```text
apps/mobile/ios/T3Code.xcworkspace
T3Code
```

The generated native directories are ignored and may be regenerated. Do not commit `apps/mobile/ios`.

### 2. Install CocoaPods

```bash
cd "$ROOT/apps/mobile/ios"
pod install
```

### 3. Check the generated identity and entitlements

Verify the bundle identifier:

```bash
grep -n "PRODUCT_BUNDLE_IDENTIFIER" \
  "$ROOT/apps/mobile/ios/T3Code.xcodeproj/project.pbxproj"
```

Inspect the generated entitlements:

```bash
plutil -p "$ROOT/apps/mobile/ios/T3Code/T3Code.entitlements"
```

A Personal Team build must not contain these unsupported keys:

```text
aps-environment
com.apple.developer.applesignin
com.apple.developer.associated-domains
com.apple.security.application-groups
```

If any appear, stop before building. Confirm that all `T3CODE_IOS_PERSONAL_TEAM_*` variables were exported before `expo prebuild`, and use current repository source. Do not manually patch the generated entitlement file as the normal solution.

### 4. Build a self-contained signed Release app

```bash
rm -rf "$DERIVED_DATA"

xcodebuild \
  -workspace "$ROOT/apps/mobile/ios/T3Code.xcworkspace" \
  -scheme T3Code \
  -configuration Release \
  -destination "platform=iOS,id=$XCODE_DEVICE_ID" \
  -derivedDataPath "$DERIVED_DATA" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  build
```

The resulting application is:

```bash
APP_PATH="$DERIVED_DATA/Build/Products/Release-iphoneos/T3Code.app"
test -d "$APP_PATH"
```

The first build for a new bundle identifier may ask Xcode to register the identifier and device and create a provisioning profile. The Mac must have a valid Xcode account session.

### 5. Validate the application before installation

Verify the bundle identifier, display name, signing team, embedded JavaScript bundle, and entitlements:

```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP_PATH/Info.plist"
/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$APP_PATH/Info.plist"
codesign -dv --verbose=2 "$APP_PATH" 2>&1 | grep -E "Identifier=|TeamIdentifier="
test -f "$APP_PATH/main.jsbundle"
codesign -d --entitlements :- "$APP_PATH" 2>/dev/null | plutil -p -
```

Expected characteristics:

- Bundle identifier equals `$BUNDLE_ID`.
- Display name is `T3 Code`.
- Team identifier equals `$TEAM_ID`.
- `main.jsbundle` exists, so Metro is not required.
- Unsupported Personal Team capabilities are absent.
- `get-task-allow` may be `true` because the app is development-signed by a Personal Team, even though Xcode used the `Release` configuration.

### 6. Install over the existing Release app

Do not uninstall first. Installing over the same bundle identifier refreshes the signed app and normally preserves its data:

```bash
xcrun devicectl device install app \
  --device "$CORE_DEVICE_ID" \
  "$APP_PATH"
```

Launch it:

```bash
xcrun devicectl device process launch \
  --device "$CORE_DEVICE_ID" \
  --terminate-existing \
  "$BUNDLE_ID"
```

Confirm the installed application:

```bash
xcrun devicectl device info apps --device "$CORE_DEVICE_ID" \
  | grep -E "T3 Code|$BUNDLE_ID"
```

If iOS blocks the first launch, trust the developer certificate under the device's **Settings → General → VPN & Device Management**. The exact Settings wording can differ by iOS version.

## Weekly refresh

For the usual 7-day Personal Team refresh:

1. Pull or select the source revision to install.
2. Connect and unlock the iPhone.
3. Confirm Xcode is still signed into the Apple ID.
4. Re-run the quick build or the explicit build.
5. Install over the same Release bundle identifier.
6. Launch and confirm the app opens.

A source-code change is not required merely to refresh provisioning. Rebuilding and reinstalling the same revision is sufficient.

The provisioning period is controlled by Apple and can vary or fail earlier if certificates, account sessions, registered devices, or generated profiles change. Treat 7 days as the normal Personal Team expectation rather than a guaranteed timer.

## Optional side-by-side development client

Use a distinct development bundle identifier:

```bash
export T3CODE_IOS_PERSONAL_TEAM=1
export T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev
export T3CODE_IOS_PERSONAL_TEAM_ID=YOUR_TEAM_ID

cd apps/mobile
vp run ios:dev
```

Run the installed development client with local Metro by following [`LOCAL_METRO.md`](LOCAL_METRO.md). The self-contained Release app does not use Metro because `main.jsbundle` is embedded during the Release build.

## Agent workflow and safeguards

When an agent performs this build:

1. Read this document and [`LOCAL_BUILD.md`](LOCAL_BUILD.md).
2. Confirm the intended Team ID, Release bundle ID, and physical device without exposing credentials.
3. Keep Release and Dev bundle identifiers distinct.
4. Use a dedicated DerivedData path under ignored `release/`.
5. Do not publish, upload, archive for distribution, create a GitHub release, or contact EAS unless explicitly requested.
6. Do not request the owner's keychain or Mac password.
7. If signing keys are unavailable over SSH, create a build script and run it in the logged-in GUI Terminal session. Never bypass keychain protections.
8. Validate the built bundle ID, team, entitlements, and `main.jsbundle` before installing.
9. Install over the Release app; do not uninstall it unless the owner explicitly requests a clean install.
10. Preserve any side-by-side Dev app and unrelated development servers.
11. Report the artifact path, bundle ID, signing team, installation result, and launch result.

Example GUI Terminal launch for an already-reviewed build script:

```bash
osascript -e 'tell application "Terminal"
  activate
  do script "/absolute/path/to/build-t3code-ios-release.sh"
end tell'
```

The script itself must contain no passwords or private keys.

## Troubleshooting

### `No profiles for ... were found`

- Confirm Xcode is signed into the correct Apple ID.
- Confirm the Team ID is correct.
- Keep `-allowProvisioningUpdates` enabled.
- Unlock and reconnect the device.
- Open the generated workspace in Xcode and inspect **Signing & Capabilities** if automatic signing still fails.

### Personal Team does not support Push Notifications

Inspect the generated entitlements. `aps-environment` must be absent. Ensure Personal Team variables were present during `expo prebuild`, not added only during `xcodebuild`.

### Signing identity is visible in Xcode but unavailable over SSH

Run the same script from the Mac's logged-in GUI Terminal session. Do not ask for or transmit the keychain password.

### Release app opens a development-client screen or asks for Metro

- Confirm `APP_VARIANT=production` was set during prebuild and build.
- Confirm the scheme was `T3Code` and configuration was `Release`.
- Confirm `$APP_PATH/main.jsbundle` exists.
- Confirm the installed bundle identifier is the Release identifier, not the `.dev` identifier.

### Installing Dev replaced Release

Both builds used the same bundle identifier. Rebuild Dev with a `.dev` identifier, install it, then reinstall Release with the original Release identifier.

### App stops launching after several days

The free provisioning profile probably expired. Reconnect the device and repeat the weekly refresh workflow.

## Cleanup and disk usage

The explicit workflow keeps its DerivedData under:

```text
release/ios-personal-release/DerivedData
```

Remove it when the artifact is no longer needed:

```bash
rm -rf release/ios-personal-release
```

Expo's generated native folders are ignored and may also be regenerated:

```bash
rm -rf apps/mobile/ios apps/mobile/android
```

Do not remove an active Metro worktree, another task's DerivedData, or unrelated Xcode archives merely to save space.
