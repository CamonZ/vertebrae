# Matches rust-toolchain.toml so the image toolchain is the one Cargo uses.
FROM rust:1.97.0-slim-trixie
LABEL org.opencontainers.image.source=https://github.com/CamonZ/vertebrae

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
