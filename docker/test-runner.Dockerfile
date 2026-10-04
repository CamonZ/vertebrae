# Matches rust-toolchain.toml so the image toolchain is the one Cargo uses.
FROM rust:1.97.0-slim-trixie
LABEL org.opencontainers.image.source=https://github.com/CamonZ/vertebrae
RUN apt-get update && apt-get install -y build-essential curl git && rm -rf /var/lib/apt/lists/*
# Prebuilt release binary; compiling jj-cli from source took ~2 minutes.
ARG JJ_VERSION=0.45.1
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) target=x86_64-unknown-linux-musl; sha=f35438350b5d61963aac5dd74ede510b31d6b9690769d1a6268cf058cc825f72 ;; \
      arm64) target=aarch64-unknown-linux-musl; sha=7349a43dd5a20dbc998b10114daa0ee63d2ab863fb822c7eb6b0ebca5903cc69 ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/jj.tar.gz "https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-${target}.tar.gz"; \
    echo "${sha}  /tmp/jj.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/jj.tar.gz -C /usr/local/bin ./jj; \
    rm /tmp/jj.tar.gz; \
    jj --version
