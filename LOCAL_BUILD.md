# Local Builds

Use these workflows to produce testable desktop installers and installable server CLI packages without publishing a release or using a cloud build runner.

All generated artifacts belong in the repository-root `release/` directory. That directory is ignored by Git; do not commit its contents.

## Prerequisites

From the repository root, install the locked dependencies:

```bash
vp install --frozen-lockfile
```

The repository requires Node.js `^24.13.1`. Vite+ can provide the pinned runtime when a system Node installation is unavailable:

```bash
eval "$(vp env print)"
node --version
```

## macOS desktop installer

Build macOS artifacts on a Mac. The desktop build requires Apple tools such as `sips`, `iconutil`, `hdiutil`, and Xcode command-line tools. Linux cannot produce the complete macOS package because native modules must be rebuilt for macOS and DMG creation uses Apple tooling.

### Apple Silicon

```bash
vp run dist:desktop:artifact \
  --platform mac \
  --target dmg \
  --arch arm64 \
  --build-version 0.0.32-local.1 \
  --verbose
```

The convenience task uses the package version from `apps/desktop/package.json` when no explicit build version is needed:

```bash
vp run dist:desktop:dmg:arm64
```

### Intel Mac

```bash
vp run dist:desktop:artifact \
  --platform mac \
  --target dmg \
  --arch x64 \
  --build-version 0.0.32-local.1 \
  --verbose
```

### Outputs

Electron Builder writes the artifacts under `release/`, including:

```text
release/T3-Code-<version>-<arch>.dmg
release/T3-Code-<version>-<arch>.dmg.blockmap
release/T3-Code-<version>-<arch>.zip
release/T3-Code-<version>-<arch>.zip.blockmap
release/latest-mac.yml
```

Local builds are unsigned and unnotarized unless `--signed` is explicitly supplied with the required Apple credentials. For a local unsigned build, macOS may require the tester to right-click the installed app and choose **Open**, or approve it under **System Settings → Privacy & Security**.

Validate a local DMG before sharing it:

```bash
hdiutil verify release/T3-Code-<version>-arm64.dmg
shasum -a 256 release/T3-Code-<version>-arm64.dmg
```

Use `--keep-stage` only when the staged application contents are needed for debugging. The default cleans temporary staging files after packaging.

## Installable server CLI

The server CLI is the `pulse` executable distributed by the `@sats-lab/pulse` npm package. A local tarball can be built and installed without publishing to npm.

### Build and pack

Build the production web client first, then build the server bundle and pack its distributable npm shape:

```bash
vp run --filter @t3tools/web build
node apps/server/scripts/cli.ts build --verbose
node apps/server/scripts/cli.ts pack \
  --app-version 0.0.32-local.1 \
  --output release/pulse-cli-local.tgz \
  --verbose
```

The `pack` command:

- Requires `apps/server/dist/bin.mjs` and `apps/server/dist/client/index.html`.
- Resolves workspace `catalog:` dependency versions into concrete npm versions.
- Excludes development dependencies and workspace-only package metadata.
- Applies production or nightly web branding according to the requested version.
- Restores `apps/server/package.json` and the built client icons after packing, including when packing fails.
- Creates a tarball only; it does not contact npm's publish endpoint or create a release.

The output is:

```text
release/pulse-cli-local.tgz
```

### Inspect the tarball

```bash
tar -xOf release/pulse-cli-local.tgz package/package.json
shasum -a 256 release/pulse-cli-local.tgz
```

The packed manifest must not contain unresolved `catalog:` or `workspace:` dependency specifications.

### Install and verify

Install the tarball globally with the Node/npm environment that should own the `pulse` executable:

```bash
eval "$(vp env print)"
npm install -g ./release/pulse-cli-local.tgz
pulse --help
```

To test without changing the normal global installation, use a temporary prefix:

```bash
prefix="$(mktemp -d)"
npm install -g --prefix "$prefix" ./release/pulse-cli-local.tgz
PATH="$prefix/bin:$PATH" pulse --help
rm -rf "$prefix"
```

Native dependencies such as `node-pty` are installed for the target machine when npm installs the tarball. Ensure the target has a supported Node version and any build tools required when a matching prebuilt native binary is unavailable.

## Versioning local artifacts

Use a valid semver prerelease version and increment it when rebuilding, for example:

```text
0.0.32-local.1
0.0.32-local.2
```

Do not reuse a production release version for locally modified code. Distinct local versions make installed artifacts and diagnostics identifiable.

## Source-control and CI policy

- Keep local artifacts under ignored `release/`.
- Do not commit DMGs, ZIPs, blockmaps, updater manifests, or npm tarballs.
- Do not add or trigger paid cloud packaging jobs for ad hoc test builds when an appropriate local host is available.
- Build macOS desktop artifacts on a Mac and use Linux or macOS for the server CLI tarball.
- Publishing npm packages, signing/notarizing applications, tagging releases, and creating GitHub releases are separate release operations and are not part of these local workflows.
