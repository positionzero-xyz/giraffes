# Build from the repository root so the box runs app/dev/bridge.ts unchanged:
#   docker build -f box/Dockerfile -t giraffes-box .
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

ARG CLAUDE_CODE_VERSION=2.1.316

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 agent && useradd --uid 1001 --gid agent --create-home --shell /usr/sbin/nologin agent \
 && groupadd --gid 1002 browser && useradd --uid 1002 --gid browser --create-home --shell /usr/sbin/nologin browser \
 && install -d -o agent -g agent -m 700 /home/agent/.claude /home/agent/brain \
 && chmod 700 /home/agent /home/browser

COPY box/package.json box/package-lock.json /opt/bridge/
RUN cd /opt/bridge && npm ci --omit=dev && npm cache clean --force \
 && ln -s /opt/bridge/node_modules/.bin/claude /usr/local/bin/claude \
 && claude --version
COPY app/dev/bridge.ts /opt/bridge/bridge.ts

ENV CLAUDE_CONFIG_DIR=/home/agent/.claude \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=8789

USER agent
WORKDIR /home/agent/brain
EXPOSE 8789
CMD ["node", "/opt/bridge/bridge.ts"]
