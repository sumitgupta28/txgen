"""
packages/models/src/models/auth.py

The Backend-for-Frontend (BFF) authentication module.

This single file is the entire security boundary of the system.
Every FastAPI service imports from here — auth logic is never duplicated.

Architecture reminder:
  Browser → FastAPI (this module runs here) → Keycloak
  The browser never calls Keycloak. Keycloak is invisible to it.

Session lifecycle:
  1. Login:   React POSTs credentials → FastAPI calls Keycloak ROPC
              → stores tokens in Redis → sets HttpOnly cookie
  2. Request: FastAPI reads cookie → looks up Redis session
              → validates/refreshes token → checks roles → processes request
  3. Logout:  FastAPI deletes Redis session → calls Keycloak logout
              → clears cookie in browser response
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import time
from typing import Any

import httpx
import redis.asyncio as aioredis
from fastapi import Cookie, Depends, HTTPException, Response, status
from jose import JWTError, jwt
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# ── Configuration (all from environment variables) ───────────────────────────

KEYCLOAK_URL    = os.getenv("KEYCLOAK_URL",    "http://keycloak:8080")
KEYCLOAK_REALM  = os.getenv("KEYCLOAK_REALM",  "txgen")
CLIENT_ID       = os.getenv("KEYCLOAK_CLIENT_ID",     "txgen-backend")
CLIENT_SECRET   = os.getenv("KEYCLOAK_CLIENT_SECRET", "")
REDIS_URL       = os.getenv("REDIS_URL",       "redis://redis:6379")

# Keycloak's token endpoint — FastAPI calls this server-to-server.
# This URL never appears in the browser's network tab.
TOKEN_URL  = f"{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}/protocol/openid-connect/token"
LOGOUT_URL = f"{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}/protocol/openid-connect/logout"

# How many seconds before expiry to proactively refresh the access token.
# 60 seconds gives plenty of buffer even under load.
REFRESH_BUFFER_SECS = 60

# Session cookie name. Must match exactly what React's axios client expects.
SESSION_COOKIE_NAME = "txgen_session"

# ── Redis client ──────────────────────────────────────────────────────────────

# Single shared async Redis client. Created at module import time.
# All FastAPI workers in the same process share this client.
_redis: aioredis.Redis = aioredis.from_url(REDIS_URL, decode_responses=True)


def _session_key(session_id: str) -> str:
    """Namespaced Redis key — prevents collisions with other Redis users."""
    return f"txgen:session:{session_id}"


# ── Pydantic schemas (used in FastAPI request/response bodies) ────────────────

class LoginRequest(BaseModel):
    """What React POSTs to /api/auth/login."""
    username: str
    password: str


class UserInfo(BaseModel):
    """What FastAPI returns to React after successful login or /api/auth/me.
    
    Notice what is NOT here: no access_token, no refresh_token.
    Tokens stay inside FastAPI. React only receives display information.
    """
    username:     str
    display_name: str
    roles:        list[str]


class SessionData(BaseModel):
    """What FastAPI stores in Redis. Never sent to the browser."""
    access_token:      str
    refresh_token:     str
    expires_at:        float   # Unix timestamp when access token expires
    refresh_expires_at: float  # Unix timestamp when refresh token expires
    username:          str
    display_name:      str
    roles:             list[str]
    keycloak_session:  str     # Keycloak session_state — needed for logout


# ── Core session operations ───────────────────────────────────────────────────

async def create_session(tokens: dict[str, Any], response: Response) -> UserInfo:
    """
    Called after Keycloak returns tokens on login.
    
    Decodes the JWT to extract user info, stores everything in Redis,
    and sets an HttpOnly cookie on the HTTP response object.
    
    The cookie is what the browser will send on every subsequent request.
    The tokens are what FastAPI stores in Redis — the browser never sees them.
    """
    # Decode without signature verification — we just received this from Keycloak
    # and trust the source. Verification happens on every subsequent request.
    payload = jwt.decode(
        tokens["access_token"],
        key="",
        algorithms=["RS256"],
        options={"verify_signature": False},
    )

    roles = payload.get("realm_access", {}).get("roles", [])
    # Filter out Keycloak's internal roles — only expose app-defined roles
    app_roles = [r for r in roles if r in ("admin", "operator", "viewer")]

    keycloak_session_state = payload.get("session_state", "")
    logger.debug(
        "JWT decoded | user=%s issuer=%s keycloak_session=%s all_realm_roles=%s app_roles=%s",
        payload.get("preferred_username", ""),
        payload.get("iss", ""),
        keycloak_session_state,
        roles,
        app_roles,
    )

    session = SessionData(
        access_token=tokens["access_token"],
        refresh_token=tokens["refresh_token"],
        expires_at=time.time() + tokens["expires_in"],
        refresh_expires_at=time.time() + tokens["refresh_expires_in"],
        username=payload.get("preferred_username", ""),
        display_name=payload.get("name", payload.get("preferred_username", "")),
        roles=app_roles,
        keycloak_session=keycloak_session_state,
    )

    # Generate a cryptographically random session ID.
    # This is what lives in the browser cookie — not the JWT.
    session_id = secrets.token_urlsafe(32)

    # Store session in Redis with TTL matching the refresh token lifetime.
    # When the refresh token expires, the Redis key expires too — automatic cleanup.
    await _redis.setex(
        _session_key(session_id),
        int(tokens["refresh_expires_in"]),
        session.model_dump_json(),
    )

    logger.info(
        "Session created | user=%s display=%r roles=%s "
        "access_ttl=%ds refresh_ttl=%ds session=%s...",
        session.username,
        session.display_name,
        session.roles,
        tokens["expires_in"],
        tokens["refresh_expires_in"],
        session_id[:8],
    )

    # Set the cookie on the response.
    # HttpOnly: JavaScript cannot read this cookie (XSS protection).
    # SameSite=strict: Cookie not sent on cross-site requests (CSRF protection).
    # Secure should be True in production (HTTPS). False here for local Docker.
    cookie_secure = os.getenv("COOKIE_SECURE", "false").lower() == "true"
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_id,
        httponly=True,
        samesite="strict",
        max_age=int(tokens["refresh_expires_in"]),
        path="/",
        secure=cookie_secure,
    )
    logger.debug(
        "Session cookie set | name=%s httponly=True samesite=strict secure=%s max_age=%ds",
        SESSION_COOKIE_NAME, cookie_secure, tokens["refresh_expires_in"],
    )

    return UserInfo(
        username=session.username,
        display_name=session.display_name,
        roles=session.roles,
    )


async def get_session(session_id: str) -> SessionData:
    """
    Look up a session in Redis by its ID.

    If the access token is about to expire, silently refreshes it before
    returning. This means the caller always gets a fresh, valid token
    without needing to think about token lifecycle at all.
    """
    logger.debug("Session lookup | session=%s...", session_id[:8])

    raw = await _redis.get(_session_key(session_id))
    if not raw:
        logger.warning("Session not found in Redis | session=%s...", session_id[:8])
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session not found or expired. Please log in again.",
        )

    session = SessionData.model_validate_json(raw)
    ttl = session.expires_at - time.time()
    logger.debug("Session found | user=%s roles=%s access_token_ttl=%.0fs session=%s...", session.username, session.roles, ttl, session_id[:8])

    # Proactive refresh: if the access token expires soon, refresh now
    # rather than letting the next request fail with a 401 from Keycloak.
    if ttl < REFRESH_BUFFER_SECS:
        logger.info(
            "Access token expiring soon, proactive refresh | user=%s ttl=%.0fs session=%s...",
            session.username, ttl, session_id[:8],
        )
        session = await _refresh_session(session_id, session)

    return session


async def _refresh_session(session_id: str, session: SessionData) -> SessionData:
    """
    Exchange the stored refresh token for a new access token.

    Called automatically by get_session() — callers never invoke this directly.
    If the refresh token itself has expired, the session is deleted from Redis
    and a 401 is raised, forcing the user to log in again.
    """
    logger.info("Token refresh attempt | user=%s realm=%s session=%s...", session.username, KEYCLOAK_REALM, session_id[:8])

    async with httpx.AsyncClient() as client:
        resp = await client.post(TOKEN_URL, data={
            "grant_type":    "refresh_token",
            "refresh_token": session.refresh_token,
            "client_id":     CLIENT_ID,
            "client_secret": CLIENT_SECRET,
        })

    if resp.status_code != 200:
        # Refresh token expired — cannot silently renew. Must re-login.
        logger.warning(
            "Token refresh failed, session invalidated | user=%s status=%d session=%s...",
            session.username, resp.status_code, session_id[:8],
        )
        await _redis.delete(_session_key(session_id))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your session has expired. Please log in again.",
        )

    tokens = resp.json()
    session.access_token      = tokens["access_token"]
    session.refresh_token     = tokens["refresh_token"]
    session.expires_at        = time.time() + tokens["expires_in"]
    session.refresh_expires_at = time.time() + tokens["refresh_expires_in"]

    # Update Redis with new tokens, reset TTL
    await _redis.setex(
        _session_key(session_id),
        int(tokens["refresh_expires_in"]),
        session.model_dump_json(),
    )

    logger.info(
        "Token refresh success | user=%s new_access_ttl=%ds new_refresh_ttl=%ds session=%s...",
        session.username, tokens["expires_in"], tokens["refresh_expires_in"], session_id[:8],
    )
    return session


async def delete_session(session_id: str, session: SessionData) -> None:
    """
    Delete the Redis session and tell Keycloak to invalidate its server-side
    session too. Called on logout.

    Without the Keycloak logout call, the Keycloak session would remain active
    even after the Redis session is deleted — a security gap where a stolen
    refresh token could still be exchanged for new access tokens.
    """
    logger.info("Logout: deleting Redis session | user=%s session=%s...", session.username, session_id[:8])

    # Delete from Redis first — even if the Keycloak call fails, the
    # session is gone from our system
    await _redis.delete(_session_key(session_id))
    logger.debug("Redis session deleted | session=%s...", session_id[:8])

    # Tell Keycloak to invalidate the session server-side
    logger.info(
        "Logout: notifying Keycloak | user=%s realm=%s keycloak_session=%s url=%s",
        session.username, KEYCLOAK_REALM, session.keycloak_session, LOGOUT_URL,
    )
    async with httpx.AsyncClient() as client:
        resp = await client.post(LOGOUT_URL, data={
            "client_id":      CLIENT_ID,
            "client_secret":  CLIENT_SECRET,
            "refresh_token":  session.refresh_token,
        })

    if resp.status_code in (200, 204):
        logger.info("Keycloak logout confirmed | user=%s status=%d", session.username, resp.status_code)
    else:
        # Ignore errors here — if Keycloak is down, we still want logout to succeed
        # from the user's perspective (our Redis session is already deleted)
        logger.warning(
            "Keycloak logout call failed (ignoring) | user=%s status=%d response=%s",
            session.username, resp.status_code, resp.text[:200],
        )


# ── FastAPI dependency functions ──────────────────────────────────────────────
#
# These are the functions that route handlers declare with Depends().
# FastAPI resolves them before calling the handler.
#
# Usage in a route:
#   @router.post("/api/seed/start")
#   async def start_seed(session: SessionData = Depends(require_role("admin"))):
#       ...

async def get_current_session(
    session_id: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> SessionData:
    """
    Base dependency: reads the session cookie and returns the session.
    Returns 401 if no cookie, session not found, or session fully expired.

    Add this to any endpoint that just needs authentication (any logged-in user).
    """
    if not session_id:
        logger.debug("Request rejected: no session cookie present | cookie_name=%s", SESSION_COOKIE_NAME)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    return await get_session(session_id)


def require_role(*roles: str):
    """
    Role-enforcing dependency factory.
    
    Returns a dependency function that:
    1. Validates the session (delegates to get_current_session)
    2. Checks that the user has at least one of the required roles
    3. Returns 403 if they don't
    
    Usage:
        @router.post("/api/seed/start")
        async def start_seed(s: SessionData = Depends(require_role("admin"))):
            ...
        
        @router.post("/api/scenarios/{id}/start")  
        async def start_scenario(s: SessionData = Depends(require_role("admin", "operator"))):
            ...
    """
    async def checker(
        session: SessionData = Depends(get_current_session),
    ) -> SessionData:
        if not any(role in session.roles for role in roles):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"This action requires one of these roles: {list(roles)}",
            )
        return session

    return checker


async def get_ws_session(token: str) -> SessionData:
    """
    WebSocket authentication — token passed as a query parameter.
    
    Browser WebSocket API cannot set custom headers, so the session ID
    is passed as ?session_id=... in the WebSocket URL. FastAPI reads it
    here and validates it against Redis exactly like a cookie.
    
    Usage in a WebSocket endpoint:
        @router.websocket("/ws/events")
        async def events_ws(websocket: WebSocket, session_id: str = Query(...)):
            try:
                session = await get_ws_session(session_id)
            except HTTPException:
                await websocket.close(code=1008)  # Policy violation
                return
            await websocket.accept()
            ...
    """
    return await get_session(token)


# ── Keycloak authentication call ──────────────────────────────────────────────

async def authenticate_with_keycloak(username: str, password: str) -> dict:
    """
    Exchange username and password for Keycloak tokens using the ROPC grant.

    This is a server-to-server call inside Docker — completely invisible
    to the browser. The password is sent over the Docker bridge network,
    not over the public internet.

    Raises HTTPException(401) if credentials are invalid.
    """
    logger.info("Keycloak auth attempt | user=%s realm=%s url=%s", username, KEYCLOAK_REALM, TOKEN_URL)

    async with httpx.AsyncClient() as client:
        resp = await client.post(TOKEN_URL, data={
            "grant_type":    "password",
            "client_id":     CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "username":      username,
            "password":      password,
            "scope":         "openid profile email roles",
        })

    if resp.status_code == 401:
        logger.warning("Keycloak auth failed: invalid credentials | user=%s realm=%s", username, KEYCLOAK_REALM)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )

    if resp.status_code != 200:
        logger.error(
            "Keycloak auth failed: service error | user=%s realm=%s status=%d response=%s",
            username, KEYCLOAK_REALM, resp.status_code, resp.text[:200],
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        )

    logger.info("Keycloak auth success | user=%s realm=%s client_id=%s", username, KEYCLOAK_REALM, CLIENT_ID)
    return resp.json()
