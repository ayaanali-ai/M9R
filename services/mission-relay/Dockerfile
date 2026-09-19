FROM node:24-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json* ./
COPY packages/runtime-core/package.json packages/runtime-core/package.json
COPY packages/runtime-core/package-lock.json* packages/runtime-core/

# Install root dependencies (including ws for Relay)
RUN npm ci --ignore-scripts

# Build runtime-core
WORKDIR /app/packages/runtime-core
RUN npm install --ignore-scripts

# Copy runtime-core source and config
COPY packages/runtime-core/tsconfig.json ./
COPY packages/runtime-core/src ./src
RUN npm run build

# Copy all source code
WORKDIR /app
COPY . .

# Build runtime-core again to ensure it's up to date with source
RUN npm run build:runtime-core

WORKDIR /app/services/mission-relay

ENV NODE_ENV=production
ENV MISSION_RELAY_HOST=0.0.0.0
ENV MISSION_RELAY_PORT=8080

EXPOSE 8080

CMD ["npm", "run", "relay:start"]