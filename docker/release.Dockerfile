# Linux amd64 release builder. Both the base and apt repository view are pinned.
# Refresh these together; see docs/updates.md (Linux release environment).
FROM ubuntu:22.04@sha256:8a2321a92b438238f93b4346fff61bc4259c99fdd4d9b52ee86f153fee0c344f

ARG DEBIAN_FRONTEND=noninteractive
RUN printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/20261109T000000Z jammy main restricted universe multiverse' \
      'deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/20261109T000000Z jammy-updates main restricted universe multiverse' \
      'deb [check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/20261109T000000Z jammy-security main restricted universe multiverse' \
      > /etc/apt/sources.list \
    # Bootstrap TLS roots using apt's signed metadata and package hashes.
    # Ubuntu's minimal base has no CA bundle; only this bootstrap skips TLS
    # peer verification. All subsequent downloads use the installed CA roots.
    && apt-get -o Acquire::https::Verify-Peer=false -o APT::Update::Error-Mode=any update \
    && apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates \
    && apt-get -o APT::Update::Error-Mode=any update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential pkg-config libssl-dev \
      gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
      libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
      file patchelf libfuse2 squashfs-tools desktop-file-utils xdg-utils rpm \
    && dpkg-query -W > /usr/local/share/release-packages.txt \
    && rm -rf /var/lib/apt/lists/*

# Tauri's linuxdeploy AppImages must work without a privileged FUSE mount.
ENV APPIMAGE_EXTRACT_AND_RUN=1
