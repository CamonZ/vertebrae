FROM rust:slim
RUN apt-get update && apt-get install -y curl git && rm -rf /var/lib/apt/lists/*
