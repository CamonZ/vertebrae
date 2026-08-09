# Vertebrae releases and update checks

The release workflow publishes the GUI, `vtb`, `vtb-daemon`, and `vtb-gate` as
separate signed artifacts. This PR defines the publication format and the
GUI's read-only update check; it does not install component updates or restart
the daemon in the background.

## Channels and tags

There are two channels:

- `release` is stable and is built from an immutable `vX.Y.Z` tag.
- `master` is the preview channel and follows the `master` branch.

Each channel has a mutable GitHub Release pointer, separate from source and
immutable build tags:

- `channel-release`
- `channel-master`

Component metadata is published at:

```text
https://github.com/CamonZ/vertebrae/releases/download/channel-<channel>/latest-<target>.json
```

Artifact URLs point to immutable releases. `VTB_UPDATE_PRIVATE_KEY` signs
component entries and the complete manifest; `VTB_UPDATE_PUBLIC_KEY` is the
repository variable used to publish the matching public key in the metadata.

Artifact names include the component, version, build, and target. Stable
versions come from the source tag. Preview versions use the workflow run
number and the source commit's short SHA as the build identity.

Immutable release titles use `Vertebrae [edge] <version> (<build>)` for
`master` builds and `Vertebrae [stable] <version> (<build>)` for tagged builds.
The immutable tag itself remains targetable by automation.

Release artifacts currently target macOS ARM64 (`aarch64-apple-darwin`) on the
`macos-26` runner, plus Linux ARM64 and x86_64. Intel macOS artifacts are not
published.

## GUI update check

The GUI uses `tauri-plugin-updater` and the signed `gui-latest.json` manifest.
It performs one read-only check as the GUI starts and repeats it every 15
minutes while the GUI is running. A slow check is single-flight, so the
interval never starts an overlapping request. When a newer GUI version is
available, the Settings rail keeps a notification badge and the application
panel receives one notification for that channel/release identity.

Transient failures are observable to the Settings surface but do not block
startup or clear the last successful availability result. Polling stops when
the GUI lifecycle ends, and callbacks from an in-flight request are ignored
after cleanup.

The check is read-only: it does not download, install, relaunch, or force a
restart. Applying an update remains an explicit GUI action to be added later.
The CLI, daemon, and gate are update targets, not update clients.

The first-run component installer remains an explicit install of the binaries
bundled with the GUI. It is separate from the channel check and does not run
at startup.

## Release procedure

1. Push `master` for a preview build, or create a `vX.Y.Z` tag for a stable
   release.
2. Build the component binaries and GUI bundles for their supported targets.
3. Sign the artifacts and generate target-specific component manifests plus
   the GUI updater manifest.
4. Upload artifacts to the immutable release before updating the channel
   pointer release.

The workflow keeps orchestration in `.github/workflows/release.yml`; the
release implementation lives in versioned scripts:

- `scripts/resolve-release-metadata.mjs` validates refs and derives release
  metadata.
- `scripts/build-release-binaries.sh` builds and names component binaries.
- `scripts/configure-gui-release.mjs` sets the GUI bundle version and updater
  endpoint.
- `scripts/publish-release-assets.sh` uploads artifacts and publishes signed
  GUI and component manifests.

## macOS signing and notarization secrets

The `master` and `release` GitHub environments must each contain these secrets
for the macOS GUI job:

- `APPLE_CERTIFICATE`: base64-encoded PKCS#12 export containing the Developer ID
  Application certificate and its private key.
- `APPLE_CERTIFICATE_PASSWORD`: password used when exporting that PKCS#12 file.
- `APPLE_SIGNING_IDENTITY`: exact certificate name, such as `Developer ID
  Application: Example, Inc. (TEAMID)`.
- `APPLE_API_KEY`: App Store Connect API key ID.
- `APPLE_API_ISSUER`: App Store Connect issuer UUID.
- `APPLE_KEY_P8`: raw multiline contents of the downloaded `AuthKey_*.p8` file,
  including its `BEGIN PRIVATE KEY` and `END PRIVATE KEY` lines.

The workflow writes `APPLE_KEY_P8` to a permission-restricted temporary file
and passes its path to Tauri as `APPLE_API_KEY_PATH`. These credentials are used
only by the macOS release build for Developer ID signing and notarization.
The Tauri updater signing secrets remain separate, and local packaging does not
use any of these release credentials.

The metadata and GUI configuration scripts can be tested locally with:

```bash
node --test scripts/resolve-release-metadata.test.mjs \
  scripts/configure-gui-release.test.mjs \
  scripts/create-gui-update-manifest.test.mjs
```

Do not move or reuse an immutable version/build tag. Channel pointers may move,
but their signed metadata must continue to reference immutable assets.
