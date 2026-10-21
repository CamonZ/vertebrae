# Build the native Podman engine at the minimum version exercised by this
# runner. Debian trixie's packaged engine predates the adapter's 5.6 floor.
FROM golang:1.24-trixie AS podman-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc make pkg-config libseccomp-dev git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/containers/podman.git /podman \
    && cd /podman \
    && git checkout 1f951695466168db2c5aa98b990379574043f9f3 \
    && make BUILDTAGS="seccomp exclude_graphdriver_btrfs exclude_graphdriver_devicemapper containers_image_openpgp" bin/podman

# Matches rust-toolchain.toml so the image toolchain is the one Cargo uses.
FROM rust:1.97.0-slim-trixie
LABEL org.opencontainers.image.source=https://github.com/CamonZ/vertebrae

# System dependencies for Tauri (WebKitGTK) and headless rendering (Xvfb)
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Tauri build dependencies
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libssl-dev \
    pkg-config \
    # Headless display
    xvfb \
    xauth \
    x11-utils \
    # WebKitWebDriver (used by tauri-driver)
    webkit2gtk-driver \
    # Native rootless Podman dependencies and standalone Compose provider.
    # The packaged Podman supplies runtime configuration/helpers; its CLI is
    # replaced below with the pinned engine built above.
    podman \
    nftables \
    docker-compose \
    uidmap \
    slirp4netns \
    passt \
    fuse-overlayfs \
    python3 \
    # Utilities
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=podman-build /podman/bin/podman /usr/local/bin/podman
RUN useradd --create-home --uid 1000 --shell /bin/bash podmantest \
    && echo 'podmantest:100000:65536' > /etc/subuid \
    && echo 'podmantest:100000:65536' > /etc/subgid

# Install Node.js 22.x LTS (needed for frontend build)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install tauri-driver for WebDriver protocol support
RUN cargo install tauri-driver

# Podman recommends this DNS helper; nested Compose stacks require it.
RUN apt-get update && apt-get install -y --no-install-recommends aardvark-dns \
    && rm -rf /var/lib/apt/lists/*

# Prepare the global GUI config directory
RUN mkdir -p /root/.config/vertebrae

# The GUI acceptance image models a normal user install: the managed links for
# vtb, vtb-daemon, and vtb-gate live here and are discoverable by GUI child
# processes as well as the acceptance harness.
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
