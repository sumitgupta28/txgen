"""
services/txgen-api/src/main.py

Transaction Generator FastAPI application.

Exposes endpoints for scenario management and ISO-JSON message emission.
The emission loop runs as an asyncio background task — it co-exists with
HTTP and WebSocket handlers within the same uvicorn event loop.
"""

import asyncio
import json
import logging
import os
import random
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s | %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
logger = logging.getLogger(__name__)

from confluent_kafka import Producer
from fastapi import (
    APIRouter,
    FastAPI,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi import Depends
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient
from pydantic import BaseModel

from models.auth import SessionData, get_ws_session, require_role
from models.iso_messages import Domain

# ── Config ────────────────────────────────────────────────────────────────────

KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "kafka:29092")
MONGO_URL     = os.getenv("MONGO_URL", "mongodb://txgen:txgen@mongodb:27017/banking_db")
CORS_ORIGINS  = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")

# ── Shared state ──────────────────────────────────────────────────────────────

_mongo    = MongoClient(MONGO_URL)
_db       = _mongo.banking_db
_producer = Producer({"bootstrap.servers": KAFKA_BROKERS})

# PAN pool loaded from MongoDB at startup — all real card PANs for the generator
_pan_pool: list[dict] = []

# Active emission task — only one scenario runs at a time
_emission_task: asyncio.Task | None = None
_scenario_state: dict = {"running": False, "tps": 0, "scenario": None, "emitted": 0}

# WebSocket connections subscribed to the live event feed
_ws_clients: list[WebSocket] = []


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _pan_pool
    logger.info("txgen-api starting up | kafka=%s mongo=%s", KAFKA_BROKERS, MONGO_URL.split("@")[-1])

    # Load PAN pool from MongoDB on startup
    # The Transaction Generator draws real PANs so every transaction can be
    # traced back to a real cardholder and account in MongoDB
    cards = list(_db.cards.find({"status": "active"}, {"pan": 1, "_id": 1,
                                                         "account_id": 1,
                                                         "acquirer_id": 1,
                                                         "scheme": 1}))
    _pan_pool = cards
    logger.info("PAN pool loaded | cards=%d", len(_pan_pool))
    if not _pan_pool:
        logger.warning("PAN pool is empty — run account seeding before starting a scenario")

    yield

    logger.info("txgen-api shutting down | flushing Kafka producer")
    _producer.flush()
    _mongo.close()
    logger.info("txgen-api shutdown complete")


# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="TxGen Transaction Generator API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGINS],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["Content-Type", "Accept"],
)

# Re-use the auth router from account-api — both services expose the same
# /api/auth/* endpoints so React can call either one for session operations
from services.account_api.routers.auth import router as auth_router  # noqa
# NOTE: In practice, copy the auth router or share via the models package.
# For clarity here we show it imported from account-api.

router = APIRouter(prefix="/api")


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class ScenarioConfig(BaseModel):
    name:         str
    domain:       str = "auth"      # auth | settlement | dispute | all
    tps:          int = 50
    failure_rate: float = 0.03      # 0–1
    fraud_rate:   float = 0.07
    response_ms:  int = 500         # simulated avg response latency

    @property
    def topic(self) -> str:
        return {"auth": "iso-auth", "settlement": "iso-settlement",
                "dispute": "iso-dispute"}.get(self.domain, "iso-auth")


# ── Scenario endpoints ────────────────────────────────────────────────────────

@router.post("/scenarios/start")
async def start_scenario(
    config: ScenarioConfig,
    session: SessionData = Depends(require_role("admin", "operator")),
) -> dict:
    global _emission_task, _scenario_state

    if _emission_task and not _emission_task.done():
        logger.warning("Scenario start rejected: already running | scenario=%s user=%s", _scenario_state["scenario"], session.username)
        return {"status": "already_running", "scenario": _scenario_state["scenario"]}

    if not _pan_pool:
        logger.error("Scenario start rejected: PAN pool empty | user=%s", session.username)
        return {"status": "error", "detail": "PAN pool empty — run account seeding first"}

    _scenario_state = {"running": True, "tps": config.tps,
                       "scenario": config.name, "emitted": 0}
    _emission_task = asyncio.create_task(_emit_loop(config))

    logger.info(
        "Scenario started | scenario=%s domain=%s tps=%d failure_rate=%.2f fraud_rate=%.2f user=%s",
        config.name, config.domain, config.tps, config.failure_rate, config.fraud_rate, session.username,
    )
    return {"status": "started", "scenario": config.name}


@router.post("/scenarios/stop")
async def stop_scenario(
    session: SessionData = Depends(require_role("admin", "operator")),
) -> dict:
    global _emission_task, _scenario_state
    scenario_name = _scenario_state.get("scenario", "none")
    emitted = _scenario_state.get("emitted", 0)
    if _emission_task and not _emission_task.done():
        _emission_task.cancel()
    _scenario_state["running"] = False
    logger.info("Scenario stopped | scenario=%s emitted=%d user=%s", scenario_name, emitted, session.username)
    return {"status": "stopped"}


@router.patch("/domains/{domain}/tps")
async def set_tps(
    domain: str,
    tps: int,
    session: SessionData = Depends(require_role("admin", "operator")),
) -> dict:
    old_tps = _scenario_state.get("tps", 0)
    _scenario_state["tps"] = max(1, min(500, tps))
    logger.info("TPS updated | domain=%s old_tps=%d new_tps=%d user=%s", domain, old_tps, _scenario_state["tps"], session.username)
    return {"domain": domain, "tps": _scenario_state["tps"]}


@router.get("/scenarios/status")
async def get_status(
    session: SessionData = Depends(require_role("admin", "operator", "viewer")),
) -> dict:
    return _scenario_state


# ── WebSocket event feed ──────────────────────────────────────────────────────

@router.websocket("/ws/events")
async def events_ws(
    websocket: WebSocket,
    session_id: str = Query(..., description="Value of the txgen_session cookie"),
) -> None:
    """
    Streams ISO-JSON events to the React Event Feed tab in real time.

    Authentication: session ID passed as query param (browser WebSocket
    cannot set custom headers). FastAPI validates it against Redis.
    """
    try:
        session = await get_ws_session(session_id)
    except Exception:
        logger.warning("WS /ws/events: invalid session | session=%s...", session_id[:8])
        await websocket.close(code=1008)
        return

    logger.info("WS /ws/events connected | user=%s total_clients=%d", session.username, len(_ws_clients) + 1)
    await websocket.accept()
    _ws_clients.append(websocket)
    try:
        while True:
            await asyncio.sleep(30)   # keepalive ping
            await websocket.send_json({"type": "ping"})
    except WebSocketDisconnect:
        logger.info("WS /ws/events disconnected | user=%s total_clients=%d", session.username, len(_ws_clients) - 1)
    finally:
        _ws_clients.remove(websocket)


app.include_router(router)


@app.get("/health")
async def health() -> dict:
    logger.debug("Health check | pan_pool_size=%d ws_clients=%d", len(_pan_pool), len(_ws_clients))
    return {"status": "ok", "service": "txgen-api", "pan_pool_size": len(_pan_pool)}


# ── Emission loop ─────────────────────────────────────────────────────────────

async def _emit_loop(config: ScenarioConfig) -> None:
    """
    Background asyncio task that emits ISO-JSON messages at the configured TPS.

    The await asyncio.sleep() call is the cooperative yield point that allows
    other coroutines (HTTP handlers, WebSocket sends) to run between batches.
    Without it this loop would starve the event loop.
    """
    interval = 1.0 / max(1, config.tps)
    logger.info("Emission loop started | scenario=%s topic=%s tps=%d interval_ms=%.1f", config.name, config.topic, config.tps, interval * 1000)

    while True:
        card = random.choice(_pan_pool)
        msg  = _build_auth_message(card, config)

        _producer.produce(
            config.topic,
            key=card.get("acquirer_id", ""),
            value=json.dumps(msg).encode("utf-8"),
        )
        _producer.poll(0)   # non-blocking — triggers delivery callbacks

        _scenario_state["emitted"] += 1
        emitted = _scenario_state["emitted"]

        logger.debug(
            "Message emitted | topic=%s mti=%s stan=%s de39=%s amount_cents=%s acquirer=%s emitted_total=%d",
            config.topic, msg["mti"], msg["de"].get("11"), msg["de"].get("39"),
            msg["de"].get("4"), card.get("acquirer_id", ""), emitted,
        )

        if emitted % 1000 == 0:
            logger.info("Emission heartbeat | scenario=%s emitted=%d tps=%d", config.name, emitted, _scenario_state["tps"])

        # Broadcast to WebSocket clients (fire-and-forget, non-blocking)
        if _ws_clients:
            feed_event = {
                "type":       "event",
                "mti":        msg["mti"],
                "acquirer_id": card.get("acquirer_id", ""),
                "result":     msg["de"].get("39", "?"),
                "amount":     int(msg["de"].get("4", "0")) / 100,
                "ts":         msg["_meta"]["generated_at"],
            }
            asyncio.create_task(_broadcast(feed_event))

        await asyncio.sleep(interval)


async def _broadcast(event: dict) -> None:
    """Send an event to all connected WebSocket clients."""
    disconnected = []
    for ws in list(_ws_clients):
        try:
            await ws.send_json(event)
        except Exception:
            disconnected.append(ws)
    for ws in disconnected:
        _ws_clients.remove(ws)
        logger.debug("WS client removed after send error | remaining=%d", len(_ws_clients))


def _build_auth_message(card: dict, config: ScenarioConfig) -> dict:
    """
    Construct a JSON-ISO auth response (MTI 0110) with realistic field values.
    The DE39 response code is weighted by the scenario's failure_rate.
    """
    stan = str(random.randint(100000, 999999))
    amount = random.randint(100, 50000)   # cents: $1 to $500

    # Weighted DE39 selection based on scenario parameters
    r = random.random()
    if r < config.failure_rate * 0.3:
        de39 = "91"   # issuer unavailable (FAILED)
    elif r < config.failure_rate:
        de39 = random.choice(["05", "51", "54", "65"])   # rejections
    else:
        de39 = "00"   # approved

    return {
        "mti":    "0110",
        "bitmap": [],
        "de": {
            "2":  card.get("pan", "4111111111111111"),
            "3":  "000000",
            "4":  str(amount).zfill(12),
            "7":  datetime.now(timezone.utc).strftime("%m%d%H%M%S"),
            "11": stan,
            "12": datetime.now(timezone.utc).strftime("%H%M%S"),
            "13": datetime.now(timezone.utc).strftime("%m%d"),
            "32": "TXGEN01",
            "37": f"RRN{stan}",
            "38": f"AUTH{stan[:4]}" if de39 == "00" else "",
            "39": de39,
            "41": f"TERM{random.randint(1000, 9999):04d}",
            "49": "840",
            "63": f"{random.uniform(0.1, 0.95):.2f}",
        },
        "_meta": {
            "acquirer_id":  str(card.get("acquirer_id", "")),
            "scenario":     config.name,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "response_ms":  config.response_ms + random.randint(-100, 200),
        },
    }
