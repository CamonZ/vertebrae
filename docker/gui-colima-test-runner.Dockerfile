ARG GUI_BASE_IMAGE
FROM docker:29-cli AS docker-cli
FROM ${GUI_BASE_IMAGE}
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
RUN apt-get update && apt-get install -y --no-install-recommends xdotool python3-gi gir1.2-gtk-3.0 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/local/bin/podman /usr/bin/podman
