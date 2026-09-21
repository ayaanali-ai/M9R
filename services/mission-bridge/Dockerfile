FROM node:24-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/runtime-core/package.json packages/runtime-core/package.json
COPY cli/package.json cli/package.json

RUN npm ci --ignore-scripts
COPY packages/runtime-core/package-lock.json* packages/runtime-core/
RUN npm --prefix packages/runtime-core install --ignore-scripts

COPY . .

RUN npm run build:runtime-core

WORKDIR /app/services/mission-bridge

ENV NODE_ENV=production
ENV PORT=8080
ENV MISSION_REPOSITORY_ROOT=/workspace/repo

RUN mkdir -p /workspace/repo

RUN git config --global --add safe.directory /workspace/repo

EXPOSE 8080

CMD ["npm", "run", "mission:bridge"]