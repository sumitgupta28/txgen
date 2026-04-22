"""
services/txgen-api/src/routers/auth.py

Copied from account-api/src/routers/auth.py for endpoint parity.
"""

import logging
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from models.auth import (
    LoginRequest,
    UserInfo,
    SessionData,
    SESSION_COOKIE_NAME,
    authenticate_with_keycloak,
    create_session,
    delete_session,
    get_current_session,
    require_role,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])

@router.post(
    "/login",
    response_model=UserInfo,
    summary="Authenticate with username and password",
    description=(
        "Receives credentials from the React login form, "
        "authenticates server-side with Keycloak (invisible to the browser), "
        "stores tokens in Redis, and sets an HttpOnly session cookie. "
        "Returns only display information — never the raw tokens."
    ),
)
async def login(
    credentials: LoginRequest,
    response: Response,
) -> UserInfo:
    logger.info("POST /api/auth/login | user=%s", credentials.username)
    tokens = await authenticate_with_keycloak(
        credentials.username,
        credentials.password,
    )
    user_info = await create_session(tokens, response)
    logger.info("Login complete | user=%s display=%r roles=%s", user_info.username, user_info.display_name, user_info.roles)
    return user_info

@router.post(
    "/logout",
    summary="End the current session",
    description=(
        "Deletes the Redis session, calls Keycloak's logout endpoint "
        "to invalidate the server-side Keycloak session, and clears the "
        "session cookie from the browser."
    ),
)
async def logout(
    response: Response,
    session_id: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
    session: SessionData = Depends(get_current_session),
) -> dict:
    logger.info("POST /api/auth/logout | user=%s session=%s...", session.username, (session_id or "")[:8])
    await delete_session(session_id, session)
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        samesite="strict",
    )
    logger.info("Logout complete | user=%s", session.username)
    return {"message": "Logged out successfully"}

@router.get(
    "/me",
    response_model=UserInfo,
    summary="Get current authenticated user",
    description=(
        "React calls this on every page load to check whether a valid session "
        "exists. Returns 401 if the user is not logged in or their session "
        "has expired, which causes React to show the login page."
    ),
)
async def me(
    session: SessionData = Depends(get_current_session),
) -> UserInfo:
    logger.debug("GET /api/auth/me | user=%s roles=%s", session.username, session.roles)
    return UserInfo(
        username=session.username,
        display_name=session.display_name,
        roles=session.roles,
    )

@router.post(
    "/refresh",
    response_model=UserInfo,
    summary="Explicit session refresh",
    description=(
        "Proactively refreshes the Keycloak access token. "
        "Not usually needed since get_current_session() auto-refreshes, "
        "but useful as a keepalive heartbeat for long-lived WebSocket sessions."
    ),
)
async def refresh(
    session: SessionData = Depends(get_current_session),
) -> UserInfo:
    logger.debug("POST /api/auth/refresh | user=%s roles=%s", session.username, session.roles)
    return UserInfo(
        username=session.username,
        display_name=session.display_name,
        roles=session.roles,
    )
