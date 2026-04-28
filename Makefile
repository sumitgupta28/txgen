# ─────────────────────────────────────────────────────────────────────────────
# TxGen Platform — Makefile
#
# All development operations go through make targets so developers
# never need to memorise long docker compose commands.
#
# Prerequisites: Docker Desktop, make
# No Python, Node.js, or any other runtime needed on the host machine.
# ─────────────────────────────────────────────────────────────────────────────

.PHONY: dev down build test logs psql mongosh kafka-topics kafka-init kafka-consume \
        seed reset-db export-realm prune help

# ── Primary commands ──────────────────────────────────────────────────────────

## Start the full development stack (hot reload enabled)
dev:
	@echo "Starting TxGen Platform..."
	@cp -n .env.example .env 2>/dev/null || true
	docker compose up --build

## Start in background (detached)
dev-bg:
	docker compose up --build -d

## Stop all containers (keeps volumes — data persists)
down:
	docker compose down

## Stop all containers AND delete all data volumes (full reset)
reset:
	docker compose down -v
	@echo "All volumes deleted. Run 'make dev' to start fresh."

## Remove all unused Docker images, containers, networks, and build cache
prune:
	docker system prune -f
	@echo "Docker system pruned."

## Rebuild all images (needed after changing Dockerfiles or packages/)
build:
	docker compose build

## Rebuild a specific service: make build-svc SVC=account-api
build-svc:
	docker compose build $(SVC)

# ── Testing ───────────────────────────────────────────────────────────────────

## Run unit tests for all Python services
test-unit:
	docker compose run --rm account-api pytest /app/tests/unit -v
	docker compose run --rm txgen-api pytest /app/tests/unit -v

## Run full integration test suite (spins up isolated environment)
test-integration:
	docker compose -f docker-compose.test.yml up --abort-on-container-exit
	docker compose -f docker-compose.test.yml down -v

## Run all tests
test: test-unit test-integration

# ── Log tailing ───────────────────────────────────────────────────────────────

## Stream logs from all services
logs:
	docker compose logs -f --tail=50

## Stream logs from a specific service: make logs-svc SVC=account-api
logs-svc:
	docker compose logs -f --tail=100 $(SVC)

## Shortcut log tails for the services you check most
logs-auth:
	docker compose logs -f --tail=100 account-api txgen-api

logs-consumers:
	docker compose logs -f --tail=100 mongo-consumer integrity-checker rag-processor

logs-rag:
	docker compose logs -f --tail=200 rag-processor

logs-kc:
	docker compose logs -f --tail=100 keycloak

# ── Database shells ───────────────────────────────────────────────────────────

## Open a psql shell in the TimescaleDB container
psql:
	docker compose exec timescaledb psql -U txgen -d txgen

## Open a mongosh shell in the MongoDB container
mongosh:
	docker compose exec mongodb mongosh -u txgen -p txgen banking_db

## Open a Redis CLI session
redis-cli:
	docker compose exec redis redis-cli

# ── Kafka tools ───────────────────────────────────────────────────────────────

## List all Kafka topics with partition + replication details
kafka-topics:
	docker compose exec kafka kafka-topics.sh \
	  --bootstrap-server localhost:9092 --describe

## Re-run topic creation (idempotent — safe to run any time)
kafka-init:
	docker compose run --rm kafka-init

## Consume messages from a topic: make kafka-consume TOPIC=iso-auth
kafka-consume:
	docker compose exec kafka kafka-console-consumer.sh \
	  --bootstrap-server localhost:9092 \
	  --topic $(TOPIC) \
	  --from-beginning \
	  --max-messages 10

# ── Keycloak helpers ──────────────────────────────────────────────────────────

## Export the current Keycloak realm config to infra/keycloak/txgen-realm.json
## Run this after making changes in the Keycloak admin UI to persist them
export-realm:
	docker compose exec keycloak \
	  /opt/keycloak/bin/kc.sh export \
	  --realm txgen \
	  --dir /tmp/export
	docker compose cp keycloak:/tmp/export/txgen-realm.json \
	  infra/keycloak/txgen-realm.json
	@echo "Realm exported to infra/keycloak/txgen-realm.json"

## Open the Keycloak admin UI in your browser
open-keycloak:
	open http://localhost:8080/admin  # macOS; use xdg-open on Linux

# ── Help ──────────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "TxGen Platform — available make targets:"
	@echo ""
	@echo "  make dev              Start full stack with hot reload"
	@echo "  make down             Stop all containers"
	@echo "  make reset            Stop + delete all data volumes"
	@echo "  make build            Rebuild all Docker images"
	@echo "  make test             Run all tests"
	@echo "  make logs             Stream all logs"
	@echo "  make logs-auth        Stream auth service logs"
	@echo "  make logs-rag         Stream RAG processor logs"
	@echo "  make psql             Open TimescaleDB shell"
	@echo "  make mongosh          Open MongoDB shell"
	@echo "  make redis-cli        Open Redis CLI"
	@echo "  make kafka-topics     List Kafka topics (with partition details)"
	@echo "  make kafka-init       Re-create topics (idempotent)"
	@echo "  make export-realm     Export Keycloak realm to JSON"
	@echo "  make prune            docker system prune (free unused images/cache)"
	@echo ""
