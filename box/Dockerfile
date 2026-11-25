# docker build -t giraffes-box:mvp box
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

RUN apt-get update \
 && apt-get upgrade -y --with-new-pkgs \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 agent && useradd --uid 1001 --gid agent --no-create-home --home-dir /data/home --shell /usr/sbin/nologin agent

COPY package.json package-lock.json /opt/box/
RUN cd /opt/box && npm ci --omit=dev && npm cache clean --force \
 && ln -s /opt/box/node_modules/.bin/claude /usr/local/bin/claude \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && claude --version \
 && rm -rf /tmp/* /var/tmp/*
COPY entrypoint.sh lockdown.sh /opt/box/
COPY src/ /opt/box/src/

ENV HOME=/data/home \
    CLAUDE_CONFIG_DIR=/data/claude \
    BOX_STATE_DIR=/data/box-state \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    BOX_PORT=8789

EXPOSE 8789
CMD ["sh", "/opt/box/entrypoint.sh"]
