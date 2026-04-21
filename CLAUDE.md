# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TxGen is a **payment network simulation platform** that generates real-time ISO 8583 messages and provides operational intelligence dashboards. It demonstrates multi-stage transaction lifecycle (auth → settlement → dispute), RAG-based (Red/Amber/Green) operational dashboards, and referential integrity validation across a complete banking system.

## Commands

All development happens inside Docker — no Python or Node required on the host.

```bash
make dev              # Start full stack with hot reload
make down             # Stop all containers
make reset            # Stop + delete all data volumes (fresh start)
make build            # Rebuild all Docker images
make test             # Run all tests (unit + integration)
make test-unit        # Run Python service unit tests only
make logs             # Stream all service logs
make logs-auth        # Stream account-api and txgen-api logs
make logs-rag         # Stream RAG processor logs
make psql             # Open TimescaleDB shell
make mongosh          # Open MongoDB shell
make redis-cli        # Open Redis CLI
make kafka-topics     # List Kafka topics
make kafka-consume TOPIC=<name>   # Consume messages from a topic
make export-realm     # Export Keycloak realm config
```

Run a single service's unit tests:
```bash
docker compose run --rm account-api pytest /app/tests/unit -v
```

## Architecture

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Tailwind + Vite |
| Backend APIs | Python 3.12 + FastAPI |
| Auth | Keycloak 24 (BFF pattern) |
| Message Bus | Apache Kafka (Confluent) |
| Transactional DB | MongoDB 7 |
| Metrics DB | TimescaleDB (Postgres 16) |
| Session Store | Redis 7 |
| Dashboards | Grafana 11 |

### Services

- **account-api** (`:8001`) — Authentication endpoints (login/logout/me) + account seeding (cardholders, accounts, cards)
- **txgen-api** (`:8002`) — Scenario management, TPS control, WebSocket event feed, ISO-JSON message generation/emission to Kafka
- **generator-ui** (`:5173`) — React dashboard: login, scenario control, live event feed
- **mongo-consumer** — Kafka → MongoDB writer; handles auth/settlement/dispute messages with atomic balance updates
- **integrity-checker** — Async Kafka consumer validating 8 referential integrity rules (orphan checks, overdraft, settlement/dispute chain); runs in separate consumer group and never blocks writes
- **rag-processor** — Sync Kafka consumer; 60-second tumbling window metrics accumulator with configurable RAG classification rules stored in TimescaleDB

### Shared Packages

Two internal packages imported by all Python services (no duplication):
- **models** — Pydantic schemas for ISO messages, auth sessions, parsed messages
- **iso_mapper** — DE (Data Element) field mapping and parsing

### Authentication — BFF Pattern (Critical)

The browser has **zero knowledge** of Keycloak. Tokens never leave FastAPI.

```
Browser ──cookie──▶ FastAPI (BFF) ──tokens──▶ Keycloak
                         │
                         └──session_id──▶ Redis
```

1. **Login**: React POSTs credentials → FastAPI calls Keycloak ROPC grant → tokens stored in Redis → HttpOnly + SameSite=strict cookie set
2. **Requests**: Cookie sent automatically → FastAPI looks up Redis → validates/refreshes JWT → checks roles via `Depends(require_role(...))`
3. **Logout**: Redis session deleted → Keycloak logout → cookie cleared
4. **Auto-refresh**: Tokens refreshed 60 seconds before expiry to prevent mid-session 401s
5. **WebSocket auth**: Session ID passed as query param (browser WS API limitation)

### Transaction Data Flow

1. Scenario start → txgen-api loads PAN pool from MongoDB
2. Asyncio background loop emits ISO-JSON auth messages at configured TPS → Kafka `iso-auth` topic + WebSocket broadcast
3. Three parallel consumer groups process each message:
   - **mongo-consumer**: atomic write (balance update + transaction record)
   - **integrity-checker**: validates referential rules asynchronously
   - **rag-processor**: accumulates windowed metrics → classifies R/A/G → writes to TimescaleDB hypertable

### Key Patterns

- **Idempotent writes**: Unique index on STAN prevents duplicate inserts on Kafka replay
- **Atomic transactions**: MongoDB sessions used for balance + transaction writes
- **Error isolation**: Parse errors route to `iso_parse_errors` Kafka topic (never lost)
- **Container networking**: All inter-service URLs use Docker Compose service names (e.g., `kafka:29092`, not `localhost:9092`)
- **Hot reload**: `docker-compose.override.yml` is auto-merged in dev mode

### Default Users (Keycloak)

| User | Password | Role |
|------|----------|------|
| admin | admin123 | Full access |
| operator_alice | operator123 | Run scenarios, view dashboards |
| viewer_carol | viewer123 | Read-only |

First boot takes ~60 seconds for infrastructure, then ~15 more seconds for services. Run `make reset` to wipe all persisted volumes and start fresh.
