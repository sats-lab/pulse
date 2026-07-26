# Running Mobile Metro Locally

Use this guide to serve JavaScript, TypeScript, React, and asset changes to an already installed **T3 Code Dev** client. Starting Metro does not rebuild or reinstall the native iOS application.

The self-contained **T3 Code** Release app does not use Metro because its `main.jsbundle` is embedded during the Release build. See [`LOCAL_BUILD_MOBILE.md`](LOCAL_BUILD_MOBILE.md) for Personal Team Release and development-client builds.

## Prerequisites

- Install the development client before starting Metro. From the repository root, build and install it on a connected iPhone with a distinct Personal Team bundle identifier:

  ```bash
  export T3CODE_IOS_PERSONAL_TEAM=1
  export T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev
  export T3CODE_IOS_PERSONAL_TEAM_ID=YOUR_TEAM_ID

  cd apps/mobile
  vp run ios:dev
  ```

  This performs a clean native prebuild and invokes the local iOS runner. Select the intended physical device if prompted. For the explicit signing workflow, provisioning troubleshooting, and agent-safe GUI Terminal builds, follow the development-client section of [`LOCAL_BUILD_MOBILE.md`](LOCAL_BUILD_MOBILE.md).

- Keep its bundle identifier separate from Release:

  ```text
  Release: com.example.t3code
  Dev:     com.example.t3code.dev
  ```

- Install repository dependencies from the repository root:

  ```bash
  vp install --frozen-lockfile
  ```

- Put the Mac and physical device on a network where the phone can reach the Mac's LAN address.

## Start Metro for the Personal Team development client

From the repository root, replace the example bundle ID and Team ID:

```bash
export APP_VARIANT=development
export T3CODE_IOS_PERSONAL_TEAM=1
export T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev
export T3CODE_IOS_PERSONAL_TEAM_ID=YOUR_TEAM_ID

cd apps/mobile
vp run dev:client
```

For the repository owner's current setup:

```bash
export APP_VARIANT=development
export T3CODE_IOS_PERSONAL_TEAM=1
export T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.chanyeinthaw.t3code.dev
export T3CODE_IOS_PERSONAL_TEAM_ID=G6B453LQLF

cd apps/mobile
vp run dev:client
```

Keep the terminal open while using **T3 Code Dev**. Metro normally uses port `8081` and prints a development-client URL similar to:

```text
exp+t3-code://expo-development-client/?url=http%3A%2F%2F<MAC-LAN-IP>%3A8081
```

Open the printed URL with **T3 Code Dev**, not the Release app. The development app's registered project scheme is `t3code-dev`; Expo may use an additional generated `exp+...` URL scheme when opening a specific Metro server.

## Verify Metro

From another terminal:

```bash
curl http://127.0.0.1:8081/status
```

Expected output:

```text
packager-status:running
```

To confirm which process owns the standard Metro port on macOS:

```bash
lsof -nP -iTCP:8081 -sTCP:LISTEN
```

Do not terminate a Metro process owned by another repository, worktree, or task. Use another explicit port when the existing process is unrelated.

## Open a specific Metro server on a physical iPhone

If automatic discovery does not find Metro, use the URL printed by Expo. It must contain a Mac address reachable from the phone, not `localhost` or `127.0.0.1`.

A typical URL is:

```text
exp+t3-code://expo-development-client/?url=http%3A%2F%2F192.168.1.20%3A8081
```

For an agent operating on the Mac, a paired physical device can be launched explicitly:

```bash
export CORE_DEVICE_ID="YOUR_COREDEVICE_ID"
export METRO_URL='exp+t3-code://expo-development-client/?url=http%3A%2F%2F<MAC-LAN-IP>%3A8081'

xcrun devicectl device process launch \
  --device "$CORE_DEVICE_ID" \
  --terminate-existing \
  --payload-url "$METRO_URL" \
  com.example.t3code.dev
```

The bundle identifier in the launch command must match the installed development client.

## When a native rebuild is unnecessary

Leave Metro running and use Fast Refresh or reload the client for changes limited to:

- JavaScript or TypeScript
- React components and state
- Styling
- Images and other Metro-served assets

## When to rebuild T3 Code Dev

Rebuild the development client when changing:

- Native Swift, Objective-C, Kotlin, Java, or C/C++ code
- Native dependencies
- Expo SDK or React Native native runtime inputs
- Expo config plugins
- Entitlements or capabilities
- Bundle identifier, URL schemes, or generated native project settings
- Any other input that changes the native runtime or Expo fingerprint

Follow the side-by-side development-client instructions in [`LOCAL_BUILD_MOBILE.md`](LOCAL_BUILD_MOBILE.md).

## Stop Metro

Normally stop the foreground process with `Ctrl-C` in the terminal that started it.

If an agent started Metro in the background, it must track and terminate only that owned process. Do not use broad commands such as `pkill node`, `killall node`, or an unscoped Expo/Metro process match.

## Troubleshooting

### `No development servers found`

Check these in order:

1. Metro status returns `packager-status:running`.
2. The phone and Mac can reach each other over the current network.
3. The URL contains the Mac's reachable LAN IP rather than localhost.
4. Metro was started with `APP_VARIANT=development`.
5. `T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID` matches the installed `.dev` application.
6. The URL was opened with **T3 Code Dev**, not **T3 Code** Release.
7. macOS firewall or VPN settings are not blocking port `8081`.

Do not rebuild the app until Metro identity and connectivity have been checked.

### Metro serves old source

Confirm Metro's current working directory:

```bash
pid="$(lsof -tiTCP:8081 -sTCP:LISTEN)"
lsof -a -p "$pid" -d cwd -Fn
```

The directory should be the intended repository's `apps/mobile` folder. Stop and restart only the incorrectly rooted Metro process.

### The Dev app was replaced by Release, or vice versa

The two builds used the same bundle identifier. Rebuild Dev with a distinct `.dev` identifier, install it, and reinstall Release with the Release identifier. App names alone do not separate installations.

### Metro started with the wrong Personal Team bundle ID

Stop the owned Metro process and restart it with the same `.dev` bundle identifier used to build the installed development client.

### Port 8081 is occupied

Inspect the owner before acting:

```bash
lsof -nP -iTCP:8081 -sTCP:LISTEN
```

If it belongs to another task, start Expo on a free explicit port while retaining the development identity:

```bash
export APP_VARIANT=development
export T3CODE_IOS_PERSONAL_TEAM=1
export T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev
export T3CODE_IOS_PERSONAL_TEAM_ID=YOUR_TEAM_ID

cd apps/mobile
vp exec expo start \
  --dev-client \
  --scheme t3code-dev \
  --clear \
  --lan \
  --port 8082
```

Open the newly printed URL containing port `8082`.

## Agent safeguards

Agents running Metro should:

1. Read this file and [`LOCAL_BUILD_MOBILE.md`](LOCAL_BUILD_MOBILE.md).
2. Verify the installed Dev bundle identifier before starting Metro.
3. Reuse a healthy Metro process only when it belongs to the intended repository and configuration.
4. Never stop unrelated development servers.
5. Track any process they start and stop only that process when verification is complete, unless the owner explicitly wants it retained.
6. Never request signing or keychain credentials merely to run Metro; Metro itself does not sign applications.
