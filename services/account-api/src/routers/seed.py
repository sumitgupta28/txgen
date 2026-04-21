"""
services/account-api/src/routers/seed.py

Account seeding endpoints — demonstrates require_role() in practice.

The auth concern is entirely handled by the Depends() declaration.
The business logic inside each handler never touches tokens or sessions.
This clean separation is the payoff of centralising auth in models/auth.py.
"""

import asyncio
import logging

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, Query
from models.auth import SessionData, require_role, get_ws_session
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/seed", tags=["seed"])


class SeedConfig(BaseModel):
    """Configuration for an account seeding run."""
    cardholders:         int = 1000
    accounts_per_holder: str = "2-3"
    cards_per_account:   str = "1-2"
    balance_high_pct:    int = 20
    balance_mid_pct:     int = 70
    balance_low_pct:     int = 10
    visa_pct:            int = 55
    mastercard_pct:      int = 28
    amex_pct:            int = 10
    discover_pct:        int = 7


# In-memory progress state — simple for a one-shot operation
_seed_progress: dict = {"phase": "idle", "count": 0, "total": 0}
_seed_task: asyncio.Task | None = None


@router.post(
    "/start",
    summary="Start account seeding",
    description="Admin only. Creates cardholders, accounts, cards in MongoDB and publishes events to Kafka.",
)
async def start_seed(
    config: SeedConfig,
    # require_role("admin") returns 403 automatically if the user lacks admin role.
    # The handler body only runs if the user IS an admin.
    session: SessionData = Depends(require_role("admin")),
) -> dict:
    global _seed_task
    if _seed_task and not _seed_task.done():
        logger.warning("Seed already running | initiated_by=%s", session.username)
        return {"status": "already_running"}

    logger.info(
        "Seed started | initiated_by=%s cardholders=%d accounts_per_holder=%s cards_per_account=%s",
        session.username, config.cardholders, config.accounts_per_holder, config.cards_per_account,
    )
    _seed_task = asyncio.create_task(_run_seed(config))
    return {"status": "started", "initiated_by": session.username}


@router.get(
    "/status",
    summary="Get seeding progress",
)
async def get_status(
    # Operators can view status — they just cannot start a new seed
    session: SessionData = Depends(require_role("admin", "operator")),
) -> dict:
    return _seed_progress


@router.websocket("/ws/progress")
async def seed_progress_ws(
    websocket: WebSocket,
    # WebSocket passes session_id as query param because browser WS cannot set headers
    session_id: str = Query(..., description="Session ID from the txgen_session cookie"),
) -> None:
    """
    Streams seeding progress to the React progress bars in real time.

    Authentication: the browser passes its session ID as a query parameter
    because the WebSocket API does not support custom headers. FastAPI
    validates it against Redis — same security as cookie-based auth.

    React usage:
        const ws = new WebSocket(
          `ws://localhost:8001/api/seed/ws/progress?session_id=${sessionId}`
        )
    """
    try:
        session = await get_ws_session(session_id)
    except Exception:
        logger.warning("WS /seed/ws/progress: invalid session | session=%s...", session_id[:8])
        await websocket.close(code=1008)  # 1008 = Policy Violation
        return

    if "admin" not in session.roles and "operator" not in session.roles:
        logger.warning("WS /seed/ws/progress: insufficient role | user=%s roles=%s", session.username, session.roles)
        await websocket.close(code=1008)
        return

    logger.info("WS /seed/ws/progress connected | user=%s", session.username)
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(_seed_progress)
            await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        logger.info("WS /seed/ws/progress disconnected | user=%s", session.username)


async def _run_seed(config: SeedConfig) -> None:
    """Background task that performs the actual seeding."""
    global _seed_progress

    phases = [
        ("cardholders", config.cardholders),
        ("accounts",    config.cardholders * 2),
        ("cards",       config.cardholders * 3),
        ("kafka",       config.cardholders * 6),
    ]

    for phase, total in phases:
        logger.info("Seed phase started | phase=%s total=%d", phase, total)
        _seed_progress = {"phase": phase, "count": 0, "total": total}
        # TODO: replace with real MongoDB writes + Kafka publishes
        # using services/seeder.py which imports pymongo and confluent_kafka
        while _seed_progress["count"] < total:
            await asyncio.sleep(0.05)
            _seed_progress["count"] = min(
                _seed_progress["count"] + 20, total
            )
        logger.info("Seed phase complete | phase=%s total=%d", phase, total)

    _seed_progress = {"phase": "complete", "count": 0, "total": 0}
    logger.info("Seed run complete")
