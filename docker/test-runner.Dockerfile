FROM rust:slim
RUN apt-get update && apt-get install -y build-essential curl git && rm -rf /var/lib/apt/lists/*
RUN cargo install --locked --bin jj jj-cli
