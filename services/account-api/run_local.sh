#!/usr/bin/env bash
# Run account-api locally without Docker.
#
# Prerequisites (must already be running, e.g. via `docker compose up -d keycloak redis mongodb kafka`):
#   - Keycloak  on localhost:8080
#   - Redis     on localhost:6379
#   - MongoDB   on localhost:27017
#   - Kafka     on localhost:9092
#
# Usage:
#   ./services/account-api/run_local.sh            # uses defaults + .env
#   KEYCLOAK_CLIENT_SECRET=abc ./services/account-api/run_local.sh
#
# The script must be run from the repository root so that packages/ is found.

set -euo pipefail

# ── Resolve repo root ─────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

# ── Load .env if present ──────────────────────────────────────────────────────

if [[ -f "${REPO_ROOT}/.env" ]]; then
    echo "[run_local] Loading ${REPO_ROOT}/.env"
    set -o allexport
    # shellcheck disable=SC1091
    source "${REPO_ROOT}/.env"
    set +o allexport
fi

# ── Environment variables ─────────────────────────────────────────────────────
# All container hostnames are replaced with localhost.

export KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
export KEYCLOAK_REALM="${KEYCLOAK_REALM:-txgen}"
export KEYCLOAK_CLIENT_ID="${KEYCLOAK_CLIENT_ID:-txgen-backend}"
export KEYCLOAK_CLIENT_SECRET="${KEYCLOAK_CLIENT_SECRET:-}"

export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export MONGO_URL="${MONGO_URL:-mongodb://txgen:txgen@localhost:27017/banking_db}"
export KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}"

export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:5173}"
export APP_URL="${APP_URL:-http://localhost:8001}"
export SPRING_BOOT_ADMIN_URL="${SPRING_BOOT_ADMIN_URL:-}"

export PYTHONUNBUFFERED=1

if [[ -z "${KEYCLOAK_CLIENT_SECRET}" ]]; then
    echo "[run_local] WARNING: KEYCLOAK_CLIENT_SECRET is not set — login will fail."
    echo "           Set it in .env or export it before running this script."
fi

# ── Python / venv setup ───────────────────────────────────────────────────────

VENV_DIR="${SCRIPT_DIR}/.venv"

if ! command -v python3.12 &>/dev/null && ! python3 --version 2>&1 | grep -q "3\.12"; then
    echo "[run_local] ERROR: Python 3.12 is required. Install it and ensure it is on PATH."
    exit 1
fi

PYTHON="${PYTHON:-$(command -v python3.12 2>/dev/null || command -v python3)}"

if [[ ! -d "${VENV_DIR}" ]]; then
    echo "[run_local] Creating virtualenv at ${VENV_DIR}"
    "${PYTHON}" -m venv "${VENV_DIR}"
fi

# Activate venv
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

# ── Install / sync dependencies ───────────────────────────────────────────────

if command -v uv &>/dev/null; then
    INSTALLER="uv pip install"
else
    INSTALLER="pip install"
    pip install --quiet --upgrade pip
fi

echo "[run_local] Installing shared packages (editable)…"
${INSTALLER} --quiet -e "${REPO_ROOT}/packages/models" -e "${REPO_ROOT}/packages/iso_mapper"

echo "[run_local] Installing account-api dependencies…"
${INSTALLER} --quiet -r "${SCRIPT_DIR}/pyproject.toml"

# ── Run ───────────────────────────────────────────────────────────────────────

echo ""
echo "[run_local] Starting account-api"
echo "  URL:              http://localhost:8001"
echo "  Docs:             http://localhost:8001/docs"
echo "  Keycloak:         ${KEYCLOAK_URL}"
echo "  Redis:            ${REDIS_URL}"
echo "  MongoDB:          ${MONGO_URL}"
echo "  Kafka:            ${KAFKA_BROKERS}"
echo ""

# PYTHONPATH ensures 'src' is importable as a package from the service directory.
export PYTHONPATH="${SCRIPT_DIR}:${PYTHONPATH:-}"

exec uvicorn src.main:app \
    --host 0.0.0.0 \
    --port 8001 \
    --reload \
    --reload-dir "${SCRIPT_DIR}/src" \
    --log-level info
