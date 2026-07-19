"""Client-side error sink (POST /api/diag/client-error).

A solo operator can't see a frontend crash that the ErrorBoundary swallows. The browser
posts uncaught render errors / window errors here so they surface in the SERVER log (which the
deployer monitors) instead of dying silently on the tablet. Fire-and-forget from the client;
this endpoint just logs and returns 204.

The contract: never 500, never trust the payload. Fields are length-capped so a hostile or
runaway client can't blow up the log line, and any failure inside the handler is swallowed —
a diagnostics sink must not become a source of errors itself.
"""

import logging

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

logger = logging.getLogger("kpfront.clienterror")

router = APIRouter(prefix="/diag", tags=["diag"])


class ClientError(BaseModel):
    """A bounded report of a frontend error. All fields optional/length-capped."""

    message: str = Field(default="", max_length=2000)
    stack: str | None = Field(default=None, max_length=8000)
    component_stack: str | None = Field(
        default=None, max_length=8000, alias="componentStack"
    )
    # 'render' (ErrorBoundary) | 'error' (window.onerror) | 'unhandledrejection'
    kind: str = Field(default="error", max_length=40)
    path: str | None = Field(default=None, max_length=400)
    build: str | None = Field(default=None, max_length=120)


@router.post("/client-error", status_code=204)
async def report_client_error(payload: ClientError, request: Request) -> None:
    """Log a client-reported error at WARNING (visible without DEBUG). Never raises."""
    try:
        ua = request.headers.get("user-agent", "?")[:300]
        logger.warning(
            "client-error kind=%s build=%s path=%s ua=%s :: %s%s%s",
            payload.kind,
            payload.build,
            payload.path,
            ua,
            payload.message,
            f"\n{payload.stack}" if payload.stack else "",
            f"\ncomponentStack:{payload.component_stack}"
            if payload.component_stack
            else "",
        )
    except Exception:  # noqa: BLE001 — a diagnostics sink must never raise
        pass
