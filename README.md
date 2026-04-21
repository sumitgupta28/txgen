# TxGen Platform

Payment network simulation platform with real-time ISO 8583 message generation,
RAG-based operational intelligence dashboards, and role-based access control.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript + Tailwind CSS + Vite |
| Backend APIs | Python 3.12 + FastAPI + uvicorn |
| Auth | Keycloak 24 (BFF pattern — invisible to browser) |
| Message bus | Apache Kafka (Confluent) |
| Transactional DB | MongoDB 7 |
| Metrics DB | TimescaleDB (Postgres 16) |
| Session store | Redis 7 |
| Dashboards | Grafana 11 |
| Container runtime | Docker Compose |

## Quick start

```bash
# 1. Clone and enter the repo
git clone https://github.com/your-org/txgen.git && cd txgen

# 2. Copy environment config (edit KEYCLOAK_CLIENT_SECRET after first boot)
cp .env.example .env

# 3. Start everything
make dev

# 4. Wait for all services to be healthy (~60s first run, ~15s after)
# You'll see "Application startup complete" from both FastAPI services

# 5. Open the app
open http://localhost:5173

# Default users (defined in infra/keycloak/txgen-realm.json):
#   admin          / admin123      → full access
#   operator_alice / operator123   → run scenarios, view dashboards
#   viewer_carol   / viewer123     → read-only
```

## How authentication works (BFF pattern)

The browser never talks to Keycloak. Keycloak is invisible to it.

```
Browser (React) → FastAPI → Keycloak
                ↑                   ↑
         Custom login form    Server-side only
         (Tailwind, our UI)   Container-to-container
```

1. User fills in the React login form and submits
2. FastAPI receives credentials, calls Keycloak server-side (ROPC flow)
3. FastAPI stores Keycloak tokens in Redis, sets an HttpOnly session cookie
4. React receives `{username, displayName, roles}` — no tokens, ever
5. Every subsequent API call sends the cookie automatically
6. FastAPI reads the cookie, looks up Redis, validates the token, checks roles

## Available commands

```bash
make dev            # Start everything with hot reload
make down           # Stop all containers
make reset          # Stop + delete all data (full clean slate)
make build          # Rebuild all Docker images
make test           # Run unit + integration tests
make logs           # Stream all logs
make logs-auth      # Stream auth service logs only
make logs-rag       # Stream RAG processor logs only
make psql           # Open TimescaleDB shell
make mongosh        # Open MongoDB shell
make redis-cli      # Open Redis CLI
make kafka-topics   # List all Kafka topics
make export-realm   # Export Keycloak realm config to JSON
```

## Service URLs (local)

| Service | URL | Notes |
|---|---|---|
| React UI | http://localhost:5173 | Login page on first visit |
| Account Generator API | http://localhost:8001/docs | FastAPI OpenAPI docs |
| Transaction Generator API | http://localhost:8002/docs | FastAPI OpenAPI docs |
| Grafana | http://localhost:3000 | admin / admin |
| Kafka UI | http://localhost:8090 | Topic browser |
| Keycloak Admin | http://localhost:8080/admin | admin / admin |

## Repository structure

```
txgen/
├── apps/generator-ui/          React + Tailwind frontend
├── packages/
│   ├── models/                 Shared Pydantic models + BFF auth module
│   └── iso_mapper/             ISO 8583 DE field mapping
├── services/
│   ├── account-api/            FastAPI — Account Generator + auth endpoints
│   ├── txgen-api/              FastAPI — Transaction Generator + emission loop
│   ├── mongo-consumer/         Kafka consumer → MongoDB writes
│   ├── integrity-checker/      Referential integrity validation
│   └── rag-processor/          Windowed RAG classification → TimescaleDB
├── infra/
│   ├── keycloak/               Realm JSON with predefined users and roles
│   ├── timescaledb/migrations/ Alembic schema migrations
│   ├── mongo/                  Index creation script
│   ├── grafana/provisioning/   Auto-provisioned datasources + dashboards
│   └── nginx/                  SPA routing config
├── tests/
│   ├── unit/                   pytest unit tests per service
│   └── integration/            testcontainers full-stack tests
├── docker-compose.yml          Base (production-like) configuration
├── docker-compose.override.yml Dev hot reload (auto-merged)
├── Makefile                    Developer command reference
└── .env.example                Environment variable documentation
```

## Roles

| Role | Seed accounts | Manage scenarios | Run scenarios | View dashboards |
|---|---|---|---|---|
| admin | ✓ | ✓ | ✓ | ✓ |
| operator | — | — | ✓ | ✓ |
| viewer | — | — | — | ✓ |

To add users: edit `infra/keycloak/txgen-realm.json` and run `make reset && make dev`,
or add them manually in the Keycloak admin UI and run `make export-realm` to persist.
