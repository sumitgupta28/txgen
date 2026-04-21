# apps/generator-ui/Dockerfile
#
# Two build targets:
#
#   dev:        Vite development server with HMR.
#               Used by docker-compose.override.yml with a bind-mount.
#               Code changes appear in the browser in milliseconds.
#
#   production: Multi-stage build. Vite builds the static bundle,
#               nginx serves it. Suitable for any deployment target.
#
# The `target` field in docker-compose.yml selects which stage to use.

# ── Stage 1: development server ───────────────────────────────────────────────
FROM node:20-alpine AS dev

WORKDIR /app

# Install dependencies first (cached layer — only rebuilds if package.json changes)
COPY apps/generator-ui/package*.json ./
RUN npm ci

# In development, the source is bind-mounted by docker-compose.override.yml
# so we do NOT copy it here. The COPY below is for the production build only.

EXPOSE 5173

# --host makes Vite listen on all interfaces (not just localhost inside the container)
# Without this, the Vite dev server is unreachable from outside the container
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]


# ── Stage 2: production build ─────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY apps/generator-ui/package*.json ./
RUN npm ci

COPY apps/generator-ui/ ./

# VITE_ prefixed env vars are baked into the static bundle at build time.
# These must be provided as build arguments — they cannot be changed after build.
ARG VITE_ACCOUNT_API_URL=http://localhost:8001
ARG VITE_TXGEN_API_URL=http://localhost:8002
ENV VITE_ACCOUNT_API_URL=$VITE_ACCOUNT_API_URL
ENV VITE_TXGEN_API_URL=$VITE_TXGEN_API_URL

RUN npm run build


# ── Stage 3: production server ────────────────────────────────────────────────
FROM nginx:alpine AS production

# Copy the Vite bundle into nginx's serve directory
COPY --from=builder /app/dist /usr/share/nginx/html

# Custom nginx config needed for React Router — all routes must serve index.html
# so that client-side navigation works when the user refreshes a non-root URL
COPY infra/nginx/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
