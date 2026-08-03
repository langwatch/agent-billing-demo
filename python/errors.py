"""Every failure this API returns has the same shape::

    {"error": {"code": "customer_exists", "message": "...", "hint": "..."}}

``code`` is the stable machine-readable discriminator the browser branches
on, ``message`` is safe to render to a person, and ``hint`` is the optional
next step. Driver exceptions, stack traces and SQL strings never reach a
client: they are logged server-side and reported as ``internal_error``.

This is the same envelope the TypeScript twin answers with, which is what
lets one browser app run against either backend.
"""

import logging
from typing import Any, Dict, Optional

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

log = logging.getLogger("acme.errors")


class ApiError(Exception):
    """A failure that is safe to describe to a client."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        hint: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.hint = hint
        self.details = details

    def body(self) -> Dict[str, Any]:
        error: Dict[str, Any] = {"code": self.code, "message": self.message}
        if self.hint:
            error["hint"] = self.hint
        if self.details:
            error["details"] = self.details
        return {"error": error}

    def response(self) -> JSONResponse:
        return JSONResponse(status_code=self.status, content=self.body())


def bad_request(code: str, message: str, hint: Optional[str] = None) -> ApiError:
    return ApiError(400, code, message, hint)


def not_found(code: str, message: str) -> ApiError:
    return ApiError(404, code, message)


def conflict(
    code: str,
    message: str,
    hint: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
) -> ApiError:
    return ApiError(409, code, message, hint, details)


def upstream_error(operation: str, error: Exception) -> ApiError:
    """The LangWatch REST calls sit between this app and its customers, so a
    failure there is reported as an upstream problem with the operation that
    failed, never as the SDK's raw error text."""
    log.error("[langwatch:%s] %s", operation, error)
    return ApiError(
        502,
        "langwatch_unavailable",
        f'The billing platform could not complete "{operation}".',
        "Confirm LANGWATCH_BASE_URL and LANGWATCH_API_KEY, then retry.",
    )


def install_error_handlers(app: Any) -> None:
    """Turn anything raised on a request path into a client-safe response.

    Known failures keep their code; everything else is logged in full and
    reported as a generic internal error so no driver text leaks.
    """

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, error: ApiError) -> JSONResponse:
        return error.response()

    @app.exception_handler(RequestValidationError)
    async def _malformed_body(
        _request: Request, error: RequestValidationError
    ) -> JSONResponse:
        # FastAPI's own 422 body is a different shape from the envelope above,
        # and a client that only knows one shape would render nothing. The
        # request-level checks in the routes cover the fields a person can get
        # wrong; this catches a body that is not even the right type.
        first = error.errors()[0] if error.errors() else {}
        field = ".".join(str(part) for part in first.get("loc", ())[1:]) or "body"
        return ApiError(
            400, "invalid_request", f"The request body is not valid: {field}."
        ).response()

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, error: Exception) -> JSONResponse:
        log.exception("[%s] unhandled failure", request.url.path, exc_info=error)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "internal_error",
                    "message": "Something went wrong on our side. Please try again.",
                    "hint": f"Check the server log for the {request.url.path} failure.",
                }
            },
        )
