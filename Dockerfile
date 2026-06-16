# ─── Stage: extract MySQL 8.0 client tools ────────────────────────
# mysql:8.0-bookworm is the same Debian Bookworm base as node:20-bookworm-slim,
# so shared system libs are compatible. We copy the binaries + MySQL-specific
# libs (libmysqlclient) into a staging dir.
FROM mysql:8.0-bookworm AS mysql-tools
RUN mkdir -p /export/bin /export/lib \
    && for b in mysql mysqldump mysqlbinlog mysqladmin; do \
         cp "/usr/bin/$b" /export/bin/; \
       done \
    && find /usr/lib -name "libmysqlclient*" -exec cp {} /export/lib/ \; \
    && find /usr/lib -name "libprotobuf*"     -exec cp {} /export/lib/ \; \
    && true

# ─── Base image ───────────────────────────────────────────────────
FROM node:20-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install MySQL 8.0 client tools copied from the official MySQL Debian image.
# Using MySQL's own binaries (not MariaDB) because mysqlbinlog must be able to
# parse MySQL 8.0 GTID binlog events — MariaDB's client fails with exit code 1.
COPY --from=mysql-tools /export/bin/ /usr/local/bin/
COPY --from=mysql-tools /export/lib/ /usr/local/lib/
RUN ldconfig

WORKDIR /app

# ─── Build frontend (npm) ─────────────────────────────────────────
FROM base AS frontend-builder
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# ─── Build backend (npm) ──────────────────────────────────────────
FROM base AS backend-builder
COPY backend/package.json ./backend/
RUN cd backend && npm install
COPY backend/ ./backend/
RUN cd backend && npm run build

# ─── Dev image (source bind-mounted by docker-compose.dev.yml) ─────
FROM base AS dev
WORKDIR /app/backend
CMD ["npm", "run", "dev"]

# ─── Production image ─────────────────────────────────────────────
FROM base AS production

WORKDIR /app

COPY --from=backend-builder /app/backend/dist ./backend/dist
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules
COPY --from=backend-builder /app/backend/package.json ./backend/package.json

COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

RUN mkdir -p /app/backend/data /app/backup_servers

WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "dist/index.js"]
