# Vertebrae releases and update checks

The release workflow publishes the GUI, `vtb`, `vtb-daemon`, and `vtb-gate` as
separate signed artifacts. This PR defines the publication format and the
GUI's read-only update check; it does not install component updates or restart
the daemon in the background.

## Channels and tags

There are two channels:

- `release` is stable and is built from an immutable `vX.Y.Z` tag.
- `master` is the preview channel and follows the `master` branch.

The channels use fixed GitHub Release pointers:

- `channel-release`
- `channel-master`

Component metadata is published at:

```text
https://github.com/CamonZ/vertebrae/releases/download/channel-<channel>/latest-<target>.json
```

Stable artifact URLs point to immutable `vX.Y.Z` releases. Master preview
artifacts are stored in the existing `channel-master` release with
version/build-qualified asset names that are never overwritten. `VTB_UPDATE_PRIVATE_KEY`
signs component entries and the complete manifest; `VTB_UPDATE_PUBLIC_KEY` is
the repository variable used to publish the matching public key in the metadata.

Artifact names include the component, version, build, and target. Stable
versions come from the source tag. Preview versions use the workflow run
number and the source commit's short SHA as the build identity.

The master release is titled `master channel`; stable release titles use
`Vertebrae [stable] <version> (<build>)`. Stable release tags remain targetable
by automation.

Release artifacts currently target macOS ARM64 (`aarch64-apple-darwin`) on the
`macos-26` runner, plus Linux ARM64 and x86_64. Intel macOS artifacts are not
published.

## GUI update check

The GUI uses `tauri-plugin-updater` and the signed `gui-latest.json` manifest.
It performs one read-only check of both the `master` and `release` channels as
the GUI starts and repeats them every 15 minutes while the GUI is running. A
slow check is single-flight, so the interval never starts overlapping checks.
Settings exposes the two channels and disables a channel when its signed
metadata cannot be fetched or verified. When a newer GUI version is available,
the Settings rail keeps a notification badge and the application panel
receives one notification for that channel/release identity.

Transient failures are observable to the Settings surface but do not block
startup or clear the last successful availability result. Polling stops when
the GUI lifecycle ends, and callbacks from an in-flight request are ignored
after cleanup.

When a check fails, the Settings surface keeps the user-facing message concise
(`The update check failed.`). The native app log records the failure reason and
then probes each configured updater endpoint once, including its URL, HTTP
status, response content type, and a bounded response preview. This makes
misconfigured or unavailable channel releases diagnosable without exposing
those transport details in the Settings UI.

The check is read-only: it does not download, install, relaunch, or force a
restart. Applying an update is a separate, explicit GUI action. Approval
starts a preflight that verifies the selected channel manifest, component
identity, target, version, build, signatures, hashes, disk space, and managed
installation paths. The GUI then downloads and verifies all four artifacts,
stages the CLI, daemon, and gate, atomically activates those managed binaries,
checks their symlinks and daemon status, and finally applies the signed GUI
artifact. A failed verification or activation preserves the prior managed
components. Successful application reports per-component progress and offers
the GUI relaunch as a deferred user action; it never forces a restart or
silently reloads the daemon. Release notes are informational and are not
required for verification or installation. The CLI, daemon, and gate are
update targets, not update clients.

The first-run component installer remains an explicit install of the binaries
bundled with the GUI. It is separate from the channel check and does not run
at startup.

## Release procedure

1. Push `master` for a preview build, or create a `vX.Y.Z` tag for a stable
   release.
2. Build the component binaries and GUI bundles for their supported targets.
3. Sign the artifacts and generate target-specific component manifests plus
   the GUI updater manifest.
4. Upload stable artifacts to their immutable release, or upload master
   artifacts to `channel-master`, before updating the channel manifests.

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

Do not move or reuse an immutable stable version tag. Master channel metadata
may move, but it must continue to reference uniquely named, signed assets.
