FROM rust:slim
RUN apt-get update && apt-get install -y build-essential curl git && rm -rf /var/lib/apt/lists/*
RUN CARGO_HTTP_TIMEOUT=120 CARGO_NET_RETRY=10 cargo install --locked --bin jj jj-cli
