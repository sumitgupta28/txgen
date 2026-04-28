#!/usr/bin/env bash
# Run mongo-consumer locally.
# Kafka and MongoDB must be reachable on localhost (or override the env vars below).
#
# Usage:
#   ./run_local.sh              # start the service
#   ./run_local.sh --setup      # only create venv + install deps, then exit
#   LOG_LEVEL=DEBUG ./run_local.sh

set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SERVICE_DIR/../.." && pwd)"
PACKAGES_DIR="$REPO_ROOT/packages"
VENV="$SERVICE_DIR/.venv"

# ── Environment ────────────────────────────────────────────────────────────────
export KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}"
export KAFKA_GROUP_ID="${KAFKA_GROUP_ID:-mongo-writer-group}"
export MONGO_URL="${MONGO_URL:-mongodb://txgen:txgen@localhost:27017/banking_db}"
export LOG_LEVEL="${LOG_LEVEL:-INFO}"

# ── Helpers ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[mongo-consumer]${NC} $*"; }
warn() { echo -e "${YELLOW}[mongo-consumer]${NC} $*"; }
err()  { echo -e "${RED}[mongo-consumer]${NC} $*" >&2; }

require_python312() {
    for candidate in python3.12 python3 python; do
        if command -v "$candidate" &>/dev/null; then
            ver=$("$candidate" -c 'import sys; print(sys.version_info[:2])')
            if [[ "$ver" == "(3, 12)" ]]; then
                echo "$candidate"; return
            fi
        fi
    done
    err "Python 3.12 not found. Install it and ensure it is on PATH."
    exit 1
}

setup() {
    local python
    python=$(require_python312)

    if [[ ! -d "$VENV" ]]; then
        log "Creating virtual environment …"
        "$python" -m venv "$VENV"
    fi

    local pip="$VENV/bin/pip"
    "$pip" install --quiet --upgrade pip

    log "Installing shared packages (models, iso_mapper) …"
    "$pip" install --quiet -e "$PACKAGES_DIR/models"
    "$pip" install --quiet -e "$PACKAGES_DIR/iso_mapper"

    log "Installing service dependencies …"
    "$pip" install --quiet -e "$SERVICE_DIR"
}

# ── Entry point ────────────────────────────────────────────────────────────────
setup

if [[ "${1:-}" == "--setup" ]]; then
    log "Setup complete."
    exit 0
fi

log "Starting mongo-consumer"
log "  KAFKA_BROKERS : $KAFKA_BROKERS"
log "  KAFKA_GROUP_ID: $KAFKA_GROUP_ID"
log "  MONGO_URL     : $MONGO_URL"
echo

# shellcheck disable=SC1091
source "$VENV/bin/activate"
cd "$SERVICE_DIR"
exec python -m src.main
