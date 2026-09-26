FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm

# unzip: bun's installer unpacks a release archive.
# lcov:  provides genhtml for the HTML coverage report (see TESTING.md).
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip lcov \
 && rm -rf /var/lib/apt/lists/*

# The ENV PATH below covers non-login shells (devcontainer lifecycle commands,
# docker exec). Login shells -- which is what the VS Code terminal opens -- run
# /etc/profile and rebuild PATH from scratch, dropping it, so set it there too.
RUN printf '%s\n' 'export PATH="/home/node/.bun/bin:$PATH"' > /etc/profile.d/bun.sh \
 && chmod 0644 /etc/profile.d/bun.sh

# Pinned to match "packageManager": "bun@1.3.14" in the root package.json,
# which is also the version CI installs.
ARG BUN_VERSION=1.3.14
USER node
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
ENV PATH=/home/node/.bun/bin:${PATH}

# Create the XDG tree as `node` BEFORE any volume is mounted into it. Docker
# creates missing mount-point parents as root, so without this /home/node/.local
# and .local/share end up root-owned and packages/core/src/global.ts fails with
# EACCES trying to mkdir ~/.local/state/opencode at startup.
RUN mkdir -p /home/node/.local/share/opencode \
             /home/node/.local/state \
             /home/node/.config/opencode \
             /home/node/.cache
