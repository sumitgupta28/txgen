"""
services/account-api/src/main.py

FastAPI application entry point for the Account Generator service.

CORS configuration is the most important thing to get right here.
Without allow_credentials=True and the explicit origin, the browser
will silently strip the session cookie from every request — the single
most common mistake when building a BFF with cookie-based auth.
"""

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .routers import auth, seed

_log_level = getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO)
logging.basicConfig(
    level=_log_level,
    format="%(asctime)s %(levelname)-8s %(name)s | %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic for the FastAPI application."""
    logger.info("account-api starting up | version=%s", app.version)
    # The Redis client in auth.py is created at module import time.
    # MongoDB and Kafka connections are created per-request in routers.
    yield
    logger.info("account-api shutting down")


app = FastAPI(
    title="TxGen Account Generator API",
    description=(
        "Manages account seeding and authentication. "
        "Uses the BFF pattern — React only calls this service. "
        "Keycloak is never exposed to the browser."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# ── CORS ─────────────────────────────────────────────────────────────────────
#
# Three settings work together to make cookie-based auth work cross-origin:
#
# allow_origins:       Must list the exact React origin — NOT "*".
#                      Wildcards cannot be combined with allow_credentials.
#
# allow_credentials:   True tells the browser it's allowed to send and receive
#                      cookies on cross-origin requests. Without this, the browser
#                      silently strips the session cookie from every API call.
#
# allow_headers:       Must include Content-Type for POST with JSON body.
#
# This CORS config only matters in development because React (port 5173) and
# FastAPI (port 8001) are on different ports — treated as different origins.
# In production behind nginx/ALB on the same domain, CORS is irrelevant.

origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")]
logger.info("CORS allowed origins | origins=%s", origins)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,         # ← essential for cookie-based BFF auth
    allow_methods=["*"],
    allow_headers=["Content-Type", "Accept"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    if request.url.path != "/health":
        duration_ms = (time.perf_counter() - start) * 1000
        logger.info(
            "HTTP %s %s %d %.0fms | client=%s",
            request.method, request.url.path, response.status_code,
            duration_ms, request.client.host if request.client else "unknown",
        )
    return response


# ── Routers ───────────────────────────────────────────────────────────────────

app.include_router(auth.router)
app.include_router(seed.router)


@app.get("/health")
async def health() -> dict:
    """
    Health check endpoint for Docker healthcheck and load balancers.
    Returns 200 if the service is running — does not check downstream deps.
    """
    logger.debug("Health check requested")
    return {"status": "ok", "service": "account-api"}
