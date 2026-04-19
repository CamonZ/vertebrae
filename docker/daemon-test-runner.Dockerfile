FROM rust:slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
