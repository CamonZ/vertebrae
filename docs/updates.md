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

## GUI update check

The GUI uses `tauri-plugin-updater` and the signed `gui-latest.json` manifest.
It checks once during startup and adds a notification when a newer GUI version
is available. A failed optional check does not block startup.

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

The metadata and GUI configuration scripts can be tested locally with:

```bash
node --test scripts/resolve-release-metadata.test.mjs \
  scripts/configure-gui-release.test.mjs
```

Do not move or reuse an immutable version/build tag. Channel pointers may move,
but their signed metadata must continue to reference immutable assets.
