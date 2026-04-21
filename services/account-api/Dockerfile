# services/account-api/Dockerfile
#
# Multi-stage build pattern used by ALL Python services in this monorepo.
# The only difference between service Dockerfiles is:
#   - The COPY path for the service source (services/account-api → services/txgen-api etc.)
#   - The CMD/port
#
# Stage 1 (builder): installs all dependencies. This layer is cached by Docker
#   and only rebuilds when pyproject.toml changes — not on every code change.
#
# Stage 2 (runtime): copies only what is needed to run. No build tools,
#   no pip cache, smaller attack surface. Used in production.
#
# The docker-compose.override.yml overrides `target: builder` in dev so that
# the source bind-mount and --reload flag work correctly.

# ── Stage 1: dependency installation ─────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

# Install uv — the fast Python package manager (replaces pip install for speed)
RUN pip install uv --quiet

# Copy shared packages first — they change rarely, so this layer is usually cached
COPY packages/ ./packages/

# Copy only the dependency manifest — NOT the source code yet.
# This means code changes do not bust the dependency cache layer.
COPY services/account-api/pyproject.toml ./pyproject.toml

# Install all dependencies including the local packages/ as editable installs.
# --system installs into the system Python so the runtime stage can COPY directly.
RUN uv pip install --system -e packages/models -e packages/iso_mapper -r pyproject.toml

# ── Stage 2: production runtime ───────────────────────────────────────────────
FROM python:3.12-slim AS runtime

WORKDIR /app

# Copy installed Python packages from the builder stage
COPY --from=builder /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy shared packages (needed for editable installs to resolve correctly)
COPY packages/ ./packages/

# Copy the application source — this is the only layer that changes on code edits
COPY services/account-api/src/ ./src/

# PYTHONUNBUFFERED ensures log output is streamed immediately to Docker logs
# rather than being buffered — critical for seeing real-time output in `make logs`
ENV PYTHONUNBUFFERED=1

# Run as non-root user — security best practice
RUN useradd --no-create-home --no-log-init txgen && chown -R txgen /app
USER txgen

EXPOSE 8001
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8001"]
