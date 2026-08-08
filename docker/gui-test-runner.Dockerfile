FROM rust:slim

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
    # Utilities
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.x LTS (needed for frontend build)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install tauri-driver for WebDriver protocol support
RUN cargo install tauri-driver

# Prepare the global GUI config directory
RUN mkdir -p /root/.config/vertebrae

# The GUI acceptance image models a normal user install: the managed links for
# vtb, vtb-daemon, and vtb-gate live here and are discoverable by GUI child
# processes as well as the acceptance harness.
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
