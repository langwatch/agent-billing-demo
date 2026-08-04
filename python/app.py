"""ACME Agents, python edition: the same small agent-platform SaaS as
``app/`` (TypeScript), built on FastAPI and the official LangWatch python SDK.
Customers sign up, add seats, create agents, and chat; every chat call goes
through the LangWatch gateway on the customer's virtual key with the end user
attributed, so metering, budgets, and billing events need no metering code
here.

This process answers the SAME HTTP contract as the Express twin: same paths,
same request bodies, same response shapes, same status codes, same
``{"error": {"code", "message", "hint"}}`` envelope. The React app in
``app/web`` is served by both and cannot tell them apart. That is the point:
the integration is the same integration in either language.

It also hosts its own webhook receiver on ``/webhooks/langwatch``, reusing the
signature module the standalone receiver uses, so the python stack is one
process end to end.

Run::

    .venv/bin/uvicorn app:app --port 4200

Needs in the environment: LANGWATCH_API_KEY, LANGWATCH_PROJECT_ID,
LANGWATCH_BASE_URL, LANGWATCH_GATEWAY_URL, PY_APP_WEBHOOK_SECRET.
"""

import env  # noqa: F401  (loads .env before anything reads it)

import json
import logging
import os
import sqlite3
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional

import langwatch
from langwatch import (
    WEBHOOK_SIGNATURE_HEADER,
    WebhookSignatureVerificationError,
    verify_webhook_signature,
)
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from starlette.staticfiles import StaticFiles

import platform_api
from errors import ApiError, bad_request, conflict, install_error_handlers, not_found, upstream_error
from gateway import MODELS, meta_string, open_chat_stream, read_gateway_failure
from live_feed import SSE_HEADERS, LiveFeed
from money import nano_to_usd, nano_to_usd_or_none
from store import CUSTOMER_SUMMARY, connect, now_iso, open_db, seat_email_for
from usage import load_budgets_or_degrade, load_seat_spend, usage_for
from webhook_ingest import ingest_envelope

#: Names the delivery, not an event: one delivery carries a whole batch, so
#: this correlates logs and is never the dedup key.
DELIVERY_ID_HEADER = "X-LangWatch-Delivery-Id"

PORT = int(os.environ.get("APP_PY_PORT", "4200"))
WEBHOOK_SECRET = os.environ.get("PY_APP_WEBHOOK_SECRET", "")


def accepted_secrets() -> List[str]:
    """Every secret this receiver accepts right now, newest first.

    Rolling a secret leaves the previous one valid for a day, and a delivery
    mid-rotation is signed with both. Keeping the outgoing secret in its own
    slot is what lets the swap happen without dropping deliveries; the SDK
    verifier takes the list and accepts a delivery matching any of them.
    """
    return [
        secret
        for secret in (
            os.environ.get("PY_APP_WEBHOOK_SECRET", ""),
            os.environ.get("PY_APP_WEBHOOK_SECRET_PREVIOUS", ""),
        )
        if secret
    ]
PUBLIC_URL = os.environ.get("APP_PY_PUBLIC_URL", f"http://localhost:{PORT}")
RECEIVER_URL = f"{PUBLIC_URL}/webhooks/langwatch"
HISTORY_LIMIT = 20

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("acme.app")

langwatch.setup(
    api_key=platform_api.API_KEY,
    endpoint_url=platform_api.BASE_URL,
    skip_open_telemetry_setup=True,
)

HERE = Path(__file__).parent
DB_PATH = HERE / "app_py.sqlite"
open_db(DB_PATH)

app = FastAPI(title="ACME Agents (python)")
install_error_handlers(app)
feed = LiveFeed()


def db() -> sqlite3.Connection:
    return connect(DB_PATH)


# ── Request bodies ──────────────────────────────────────────────────────
# Every field is optional with a default so a missing one is answered by the
# route's own check, with the same code and status the TypeScript twin uses,
# rather than by a framework 422 the browser app does not know how to read.


class SignUpIn(BaseModel):
    name: str = ""
    email: Optional[str] = None


class SeatIn(BaseModel):
    email: str = ""


class AgentIn(BaseModel):
    name: str = ""
    system_prompt: str = "You are a concise, helpful assistant."
    model: str = MODELS[0]


class ChatIn(BaseModel):
    agent_id: Optional[int] = None
    seat_id: Optional[int] = None
    message: str = ""


class ClosePeriodIn(BaseModel):
    budget: str = "all"


class LimitIn(BaseModel):
    limit_usd: Optional[float] = None


# ── Sign-up ─────────────────────────────────────────────────────────────


@app.post("/api/customers", status_code=201)
async def signup(body: SignUpIn) -> Dict[str, Any]:
    """The moment the billing platform gets provisioned: one call creates the
    workspace, mints its virtual key, attaches its three budgets, and seats the
    person who signed up."""
    name = body.name.strip()
    if not name:
        raise bad_request("name_required", "Enter a company name to continue.")
    if len(name) > 60:
        raise bad_request("name_too_long", "Company names are limited to 60 characters.")

    # Look before minting: a name collision must never leave an orphan virtual
    # key behind on the platform.
    with db() as conn:
        existing = conn.execute(
            "SELECT id, name FROM customers WHERE name = ? COLLATE NOCASE", (name,)
        ).fetchone()
    if existing:
        raise conflict(
            "customer_exists",
            f"A workspace named {existing['name']} already exists.",
            "Open it instead, or pick a different name.",
            {"existing": dict(existing)},
        )

    try:
        provisioned = await run_in_threadpool(platform_api.provision_tenant, name)
    except Exception as error:
        raise upstream_error("provision the workspace", error)

    seat_email = seat_email_for(body.email, name)
    try:
        with db() as conn:
            stamp = now_iso()
            cursor = conn.execute(
                """INSERT INTO customers (
                       name, virtual_key_id, virtual_key_secret, hard_cap_budget_id,
                       soft_cap_budget_id, per_user_budget_id, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    name,
                    provisioned.virtual_key_id,
                    provisioned.virtual_key_secret,
                    provisioned.hard_cap_budget_id,
                    provisioned.soft_cap_budget_id,
                    provisioned.per_user_budget_id,
                    stamp,
                ),
            )
            customer_id = cursor.lastrowid
            conn.execute(
                "INSERT INTO seats (customer_id, email, created_at) VALUES (?, ?, ?)",
                (customer_id, seat_email, stamp),
            )
    except sqlite3.IntegrityError:
        # Two sign-ups raced for the same name. The key minted a moment ago has
        # no owner, so hand it back rather than leaking it.
        try:
            await run_in_threadpool(
                platform_api.revoke_virtual_key, provisioned.virtual_key_id
            )
        except Exception as revoke_error:
            log.error("[langwatch:revoke-orphan] %s", revoke_error)
        with db() as conn:
            winner = conn.execute(
                "SELECT id, name FROM customers WHERE name = ? COLLATE NOCASE", (name,)
            ).fetchone()
        raise conflict(
            "customer_exists",
            f"A workspace named {name} already exists.",
            "Open it instead, or pick a different name.",
            {"existing": dict(winner)} if winner else None,
        )

    customer = customer_summary(customer_id)
    feed.publish({"kind": "customer_created", "customer": customer})
    return {
        "customer": customer,
        "provisioned": {
            "virtual_key_id": provisioned.virtual_key_id,
            "hard_cap_usd": float(platform_api.CAPS["hard_usd"]),
            "soft_cap_usd": float(platform_api.CAPS["soft_usd"]),
            "per_seat_cap_usd": float(platform_api.CAPS["per_seat_usd"]),
        },
    }


@app.get("/api/customers")
def customers() -> Dict[str, Any]:
    return {"customers": all_customer_summaries()}


@app.get("/api/customers/{customer_id}")
def workspace(customer_id: int) -> Dict[str, Any]:
    with db() as conn:
        customer = require_customer(conn, customer_id)
        return {
            "customer": customer_summary(customer["id"]),
            "seats": [
                dict(row)
                for row in conn.execute(
                    "SELECT id, email FROM seats WHERE customer_id = ? ORDER BY id",
                    (customer["id"],),
                )
            ],
            "agents": [
                dict(row)
                for row in conn.execute(
                    """SELECT id, name, model, system_prompt, created_at
                       FROM agents WHERE customer_id = ? ORDER BY id""",
                    (customer["id"],),
                )
            ],
        }


# ── Seats and agents ────────────────────────────────────────────────────


@app.post("/api/customers/{customer_id}/seats", status_code=201)
def add_seat(customer_id: int, body: SeatIn) -> Dict[str, Any]:
    email = body.email.strip().lower()
    if "@" not in email:
        raise bad_request("email_invalid", "Enter a valid email address for the seat.")
    with db() as conn:
        customer = require_customer(conn, customer_id)
        try:
            cursor = conn.execute(
                "INSERT INTO seats (customer_id, email, created_at) VALUES (?, ?, ?)",
                (customer["id"], email, now_iso()),
            )
        except sqlite3.IntegrityError:
            raise conflict("seat_exists", f"{email} already has a seat here.")
        return {"seat": {"id": cursor.lastrowid, "email": email}}


@app.post("/api/customers/{customer_id}/agents", status_code=201)
def add_agent(customer_id: int, body: AgentIn) -> Dict[str, Any]:
    name = body.name.strip()
    if not name:
        raise bad_request("name_required", "Give the agent a name.")
    if body.model not in MODELS:
        raise bad_request("model_unsupported", f"{body.model} is not available on this plan.")
    with db() as conn:
        customer = require_customer(conn, customer_id)
        stamp = now_iso()
        cursor = conn.execute(
            """INSERT INTO agents (customer_id, name, system_prompt, model, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (customer["id"], name, body.system_prompt, body.model, stamp),
        )
        return {
            "agent": {
                "id": cursor.lastrowid,
                "name": name,
                "model": body.model,
                "system_prompt": body.system_prompt,
                "created_at": stamp,
            }
        }


@app.get("/api/customers/{customer_id}/agents/{agent_id}/messages")
def messages(customer_id: int, agent_id: int) -> Dict[str, Any]:
    with db() as conn:
        customer = require_customer(conn, customer_id)
        agent = require_agent(conn, agent_id, customer["id"])
        return {
            "messages": [
                dict(row)
                for row in conn.execute(
                    """SELECT id, role, content, gateway_request_id, created_at
                       FROM messages WHERE agent_id = ? ORDER BY id""",
                    (agent["id"],),
                )
            ]
        }


# ── Chat: the request path ──────────────────────────────────────────────


@app.post("/api/chat")
async def chat(body: ChatIn):
    """Answer as a Server-Sent Event stream so tokens appear as the model
    produces them.

    The gateway decides the request before the first token, so a refusal is
    still a plain JSON error with its own status code; only a failure that
    arrives mid-stream rides the stream, because by then the 200 is spent.
    """
    message = body.message.strip()
    if not message:
        raise bad_request("message_required", "Type a message first.")

    with db() as conn:
        agent = conn.execute(
            "SELECT * FROM agents WHERE id = ?", (body.agent_id,)
        ).fetchone()
        if not agent:
            raise not_found("agent_not_found", "That agent no longer exists.")
        seat = conn.execute("SELECT * FROM seats WHERE id = ?", (body.seat_id,)).fetchone()
        if not seat or seat["customer_id"] != agent["customer_id"]:
            raise not_found(
                "seat_not_found", "That seat does not belong to this workspace."
            )
        customer = conn.execute(
            "SELECT * FROM customers WHERE id = ?", (agent["customer_id"],)
        ).fetchone()
        history = [
            {"role": row["role"], "content": row["content"]}
            for row in reversed(
                conn.execute(
                    """SELECT role, content FROM messages WHERE agent_id = ?
                       ORDER BY id DESC LIMIT ?""",
                    (agent["id"], HISTORY_LIMIT),
                ).fetchall()
            )
        ]

    try:
        stream = await open_chat_stream(
            virtual_key_secret=customer["virtual_key_secret"],
            model=agent["model"],
            system_prompt=agent["system_prompt"],
            history=[*history, {"role": "user", "content": message}],
            end_user_id=seat["email"],
        )
    except Exception as error:
        raise chat_failure(error)

    async def frames() -> AsyncIterator[str]:
        answer = ""
        try:
            async for delta in stream.deltas():
                answer += delta
                yield frame({"type": "delta", "text": delta})
        except Exception as error:
            # Tokens were already on the wire, so the failure has to ride the
            # same stream. The browser renders it as the error state either
            # way.
            yield frame({"type": "error", "error": chat_failure(error).body()["error"]})
            return

        # The exchange is stored once the gateway has answered. A rejected
        # request leaves no trace in the transcript, so a customer who was
        # blocked by a cap does not come back to a conversation containing
        # messages that were never delivered.
        with db() as conn:
            stamp = now_iso()
            conn.execute(
                """INSERT INTO messages (agent_id, customer_id, user_id, role, content, created_at)
                   VALUES (?, ?, ?, 'user', ?, ?)""",
                (agent["id"], customer["id"], seat["id"], message, stamp),
            )
            stored = conn.execute(
                """INSERT INTO messages (
                       agent_id, customer_id, user_id, role, content,
                       gateway_request_id, created_at
                   ) VALUES (?, ?, ?, 'assistant', ?, ?, ?)""",
                (
                    agent["id"],
                    customer["id"],
                    seat["id"],
                    answer,
                    stream.gateway_request_id,
                    stamp,
                ),
            )

        feed.publish(
            {
                "kind": "chat_request",
                "customer_id": customer["id"],
                "gateway_request_id": stream.gateway_request_id,
            }
        )
        yield frame(
            {
                "type": "done",
                "message_id": stored.lastrowid,
                "content": answer,
                "gateway_request_id": stream.gateway_request_id,
                "input_tokens": stream.input_tokens,
                "output_tokens": stream.output_tokens,
            }
        )

    return StreamingResponse(
        frames(), media_type="text/event-stream", headers=SSE_HEADERS
    )


def frame(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def chat_failure(error: Exception) -> ApiError:
    """Budget breaches come back from the gateway as 402 with machine-readable
    meta saying WHICH cap ran out: ``budget_scope: "attributed_user"`` is this
    seat's allowance, ``"virtual_key"`` is the whole workspace's cap. That
    distinction is the difference between "you hit your limit" and "your
    company hit its limit", so it survives all the way to the screen.

    Scope kinds and windows are lowercase snake on the wire, so the branch
    below matches one spelling and does not normalize anything first.
    """
    if isinstance(error, ApiError):
        return error
    details = read_gateway_failure(error)
    if details and details.code == "budget_exceeded":
        scope = meta_string(details.meta, "budget_scope")
        per_seat = scope == "attributed_user"
        return ApiError(
            402,
            "budget_exceeded",
            "You have used up your personal AI allowance for this period."
            if per_seat
            else "Your workspace has reached its AI budget for this period.",
            "Your allowance resets at the start of next month."
            if per_seat
            else "An admin can close the billing period to admit traffic again.",
            {
                "budget_scope": scope,
                "budget_id": meta_string(details.meta, "budget_id"),
                "budget_window": meta_string(details.meta, "budget_window"),
            },
        )
    if details and details.code == "end_user_required":
        return ApiError(
            400,
            "end_user_required",
            "This workspace requires every request to be attributed to a seat.",
            "Pick a seat before sending.",
        )
    if details:
        log.error("[gateway] %s %s", details.code, details.message)
        return ApiError(
            502,
            details.code,
            "The model gateway refused this request.",
            details.message,
        )
    return upstream_error("reach the model gateway", error)


# ── Usage, events and the live feed ─────────────────────────────────────


@app.get("/api/customers/{customer_id}/usage")
async def usage(customer_id: int) -> Dict[str, Any]:
    with db() as conn:
        customer = require_customer(conn, customer_id)
        virtual_key_id = customer["virtual_key_id"]
        seats = seat_emails(conn, customer["id"])
    budgets = await run_in_threadpool(load_budgets_or_degrade)
    seat_spend = await run_in_threadpool(load_seat_spend, budgets["data"])
    with db() as conn:
        return usage_for(
            conn,
            virtual_key_id=virtual_key_id,
            seats=seats,
            budget_data=budgets["data"],
            seat_spend=seat_spend,
            degraded=budgets["degraded"],
        )


@app.get("/api/customers/{customer_id}/billing-events")
def customer_billing_events(customer_id: int, limit: int = 25) -> Dict[str, Any]:
    with db() as conn:
        customer = require_customer(conn, customer_id)
        return {
            "events": recent_events(conn, bounded(limit, 25), customer["virtual_key_id"])
        }


@app.get("/api/events")
def events(limit: int = 50) -> Dict[str, Any]:
    with db() as conn:
        return {"events": recent_events(conn, bounded(limit, 50))}


@app.get("/api/events/stream")
def events_stream() -> StreamingResponse:
    return StreamingResponse(
        feed.subscribe(), media_type="text/event-stream", headers=SSE_HEADERS
    )


# ── Owner console ───────────────────────────────────────────────────────


@app.get("/api/admin/overview")
async def admin_overview() -> Dict[str, Any]:
    budgets = await run_in_threadpool(load_budgets_or_degrade)
    seat_spend = await run_in_threadpool(load_seat_spend, budgets["data"])
    with db() as conn:
        rows = [
            {
                "customer": customer,
                "usage": usage_for(
                    conn,
                    virtual_key_id=customer["virtual_key_id"],
                    seats=seat_emails(conn, customer["id"]),
                    budget_data=budgets["data"],
                    seat_spend=seat_spend,
                    degraded=budgets["degraded"],
                ),
            }
            for customer in all_customer_summaries(conn)
        ]
        event_count = conn.execute("SELECT COUNT(*) AS count FROM billing_events").fetchone()[
            "count"
        ]
        last_event = conn.execute(
            "SELECT received_at FROM billing_events ORDER BY received_at DESC LIMIT 1"
        ).fetchone()

    receiver = {
        "registered": False,
        "url": RECEIVER_URL,
        "events_ingested": event_count,
        "last_event_at": last_event["received_at"] if last_event else None,
        "status": None,
        "last_success_at": None,
    }
    try:
        status = await run_in_threadpool(platform_api.receiver_status, RECEIVER_URL)
        receiver.update(
            registered=status.registered,
            status=status.status,
            last_success_at=status.last_success_at,
        )
    except Exception as error:
        log.error("[langwatch:webhooks.list] %s", error)

    # Totalled over the nano-USD integers and converted once: adding the
    # per-tenant dollar figures instead would drift from the platform's own
    # total by a little more with every tenant.
    total_nano_usd = sum(row["usage"]["ledger"]["cost_nano_usd"] for row in rows)
    return {
        "customers": rows,
        "totals": {
            "customers": len(rows),
            "requests": sum(row["usage"]["ledger"]["requests"] for row in rows),
            "cost_nano_usd": total_nano_usd,
            "cost_usd": nano_to_usd(total_nano_usd),
            "events": event_count,
        },
        "receiver": receiver,
        "degraded": budgets["degraded"],
    }


@app.post("/api/customers/{customer_id}/close-period")
async def close_period(customer_id: int, body: ClosePeriodIn) -> Dict[str, Any]:
    """Close a billing period. Reset moves the manual window's boundary; it
    never mutates recorded spend, so the ledger and every emitted event stay
    immutable and reconciliation is unaffected by a period close."""
    with db() as conn:
        customer = require_customer(conn, customer_id)
        virtual_key_id = customer["virtual_key_id"]

    # Closing a period moves the manual window boundary. The per-seat allowance
    # rides a month window and rolls over on its own, so it is deliberately
    # left alone: closing the company's books does not hand every employee a
    # fresh personal allowance.
    caps = [
        cap
        for cap in await customer_budgets(virtual_key_id)
        if cap.window == "manual"
        and (
            body.budget == "all"
            or (cap.on_breach == "block" if body.budget == "hard" else cap.on_breach == "warn")
        )
    ]
    if not caps:
        raise not_found(
            "budget_not_found", "This workspace has no manual-window cap to reset."
        )

    reset: List[str] = []
    for cap in caps:
        try:
            await run_in_threadpool(
                platform_api.reset_budget, cap.id, "ACME Agents period close"
            )
        except Exception as error:
            raise upstream_error(f"reset {cap.name}", error)
        reset.append("hard cap" if cap.on_breach == "block" else "soft cap")
        feed.publish(
            {"kind": "budget_reset", "customer_id": customer_id, "budget": cap.name}
        )
    return {"reset": reset, "customer_id": customer_id}


@app.post("/api/customers/{customer_id}/budgets/{budget_id}/limit")
async def set_cap(customer_id: int, budget_id: str, body: LimitIn) -> Dict[str, Any]:
    """Move a customer's cap. The owner console uses this to put a workspace on
    a different plan; the platform keeps the window and the recorded spend, so
    raising a limit admits traffic again with the books intact."""
    with db() as conn:
        customer = require_customer(conn, customer_id)
        virtual_key_id = customer["virtual_key_id"]

    owned = await customer_budgets(virtual_key_id)
    if not any(cap.id == budget_id for cap in owned):
        raise not_found("budget_not_found", "That cap does not belong to this workspace.")
    limit = body.limit_usd
    if limit is None or limit <= 0:
        raise bad_request("limit_invalid", "Enter a limit greater than zero.")

    try:
        # The limit crosses as a decimal string, which is how the API takes an
        # amount; what comes back is read as the canonical integer.
        updated = await run_in_threadpool(
            platform_api.set_budget_limit, budget_id, f"{limit:.6f}"
        )
    except Exception as error:
        raise upstream_error("update the cap", error)
    return {
        "budget_id": updated["id"],
        "limit_nano_usd": updated["limit_nano_usd"],
        "limit_usd": nano_to_usd_or_none(updated["limit_nano_usd"]),
    }


@app.get("/api/health")
async def health() -> Dict[str, Any]:
    budgets = await run_in_threadpool(load_budgets_or_degrade)
    return {
        "app": "ok",
        "webhook_secret": "configured" if WEBHOOK_SECRET else "missing",
        "receiver_url": RECEIVER_URL,
        "langwatch": "degraded" if budgets["degraded"] else "ok",
    }


# ── The receiver: this app ingests its own billing events ───────────────


@app.post("/webhooks/langwatch")
async def receive(request: Request):
    """Same contract as the standalone receivers: verify over the exact raw
    bytes, ingest idempotently, 2xx only after durable ingest.

    ``X-LangWatch-Delivery-Id`` names the DELIVERY, which carries the whole
    batch: a log correlation handle, never the dedup key. Dedup is on the
    envelope ``id`` inside the body, which the archive owns.
    """
    raw = await request.body()
    try:
        # The SDK verifier over the raw bytes: it takes every secret this
        # receiver currently accepts, so a delivery signed during a rotation
        # verifies under either one.
        verify_webhook_signature(
            body=raw,
            header=request.headers.get(WEBHOOK_SIGNATURE_HEADER, ""),
            secret=accepted_secrets(),
        )
    except WebhookSignatureVerificationError as error:
        log.warning("[webhook] rejected: %s", error.code)
        return JSONResponse(
            status_code=401,
            content={"error": {"code": error.code, "message": "Signature check failed."}},
        )
    except TypeError:
        # A missing secret is this app's configuration mistake, not a bad
        # delivery. Answering 401 there would blame the sender and hide a
        # receiver that can no longer verify anything.
        log.error("[webhook] cannot verify: no signing secret configured")
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "receiver_misconfigured",
                    "message": "This receiver has no signing secret configured.",
                }
            },
        )

    try:
        batch = json.loads(raw).get("batch", [])
    except json.JSONDecodeError:
        return JSONResponse(
            status_code=400,
            content={
                "error": {"code": "invalid_payload", "message": "Body is not a JSON batch."}
            },
        )

    # Answer 2xx only after the batch is durably stored: a failed write has to
    # fail the delivery so LangWatch retries it.
    ingested = []
    with db() as conn:
        for envelope in batch:
            outcome, row = ingest_envelope(conn, envelope)
            if outcome == "ingested" and row:
                ingested.append(row)
    for row in ingested:
        feed.publish({"kind": "billing_event", "event": present_event(row)})

    # The delivery id correlates this log line with the delivery log on the
    # LangWatch side. It identifies the DELIVERY, which carries the whole
    # batch, so dedup stays on the envelope ids handled above.
    delivery_id = request.headers.get(DELIVERY_ID_HEADER, "unknown")
    log.info(
        "[webhook] delivery %s: %s delivered, %s new",
        delivery_id,
        len(batch),
        len(ingested),
    )
    return {"received": len(batch), "ingested": len(ingested)}


# ── Helpers ─────────────────────────────────────────────────────────────


async def customer_budgets(virtual_key_id: str) -> List[platform_api.BudgetSnapshot]:
    """The caps that apply to a workspace, resolved from the platform rather
    than from the ids stored at sign-up."""
    budgets = await run_in_threadpool(load_budgets_or_degrade)
    if not budgets["data"]:
        raise upstream_error(
            "read this workspace's caps", RuntimeError("budgets unavailable")
        )
    per_key, template = platform_api.budgets_for_key(budgets["data"], virtual_key_id)
    return [*per_key, template] if template else list(per_key)


def require_customer(conn: sqlite3.Connection, customer_id: int) -> sqlite3.Row:
    customer = conn.execute(
        "SELECT * FROM customers WHERE id = ?", (customer_id,)
    ).fetchone()
    if not customer:
        raise not_found("customer_not_found", "That workspace does not exist.")
    return customer


def require_agent(
    conn: sqlite3.Connection, agent_id: int, customer_id: int
) -> sqlite3.Row:
    agent = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
    if not agent or agent["customer_id"] != customer_id:
        raise not_found("agent_not_found", "That agent does not exist in this workspace.")
    return agent


def customer_summary(customer_id: int) -> Dict[str, Any]:
    with db() as conn:
        return dict(
            conn.execute(f"{CUSTOMER_SUMMARY} WHERE c.id = ?", (customer_id,)).fetchone()
        )


def all_customer_summaries(conn: Optional[sqlite3.Connection] = None) -> List[Dict[str, Any]]:
    if conn is not None:
        return [dict(row) for row in conn.execute(f"{CUSTOMER_SUMMARY} ORDER BY c.id")]
    with db() as owned:
        return [dict(row) for row in owned.execute(f"{CUSTOMER_SUMMARY} ORDER BY c.id")]


def seat_emails(conn: sqlite3.Connection, customer_id: int) -> List[str]:
    return [
        row["email"]
        for row in conn.execute(
            "SELECT email FROM seats WHERE customer_id = ?", (customer_id,)
        )
    ]


def bounded(limit: int, fallback: int) -> int:
    try:
        return min(max(int(limit), 1), 200)
    except (TypeError, ValueError):
        return fallback


def recent_events(
    conn: sqlite3.Connection, limit: int, virtual_key_id: Optional[str] = None
) -> List[Dict[str, Any]]:
    if virtual_key_id:
        rows = conn.execute(
            """SELECT * FROM billing_events WHERE virtual_key_id = ?
               ORDER BY received_at DESC, rowid DESC LIMIT ?""",
            (virtual_key_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM billing_events ORDER BY received_at DESC, rowid DESC LIMIT ?",
            (limit,),
        ).fetchall()
    names = customer_name_by_key(conn)
    return [present_event(row, names) for row in rows]


def customer_name_by_key(conn: sqlite3.Connection) -> Dict[str, str]:
    return {
        row["virtual_key_id"]: row["name"]
        for row in conn.execute("SELECT name, virtual_key_id FROM customers")
    }


def present_event(
    row: Any, names: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    if names is None:
        with db() as conn:
            names = customer_name_by_key(conn)
    payload = json.loads(row["payload"])
    error = (payload.get("data") or {}).get("error") or {}
    return {
        "event_id": row["event_id"],
        "type": row["type"],
        "gateway_request_id": row["gateway_request_id"],
        "virtual_key_id": row["virtual_key_id"],
        "customer_name": names.get(row["virtual_key_id"]) if row["virtual_key_id"] else None,
        "end_user_id": row["end_user_id"],
        "model": row["model"],
        "status": row["status"],
        # A rejected request bills nothing, so the reason it was rejected is
        # the only useful figure on that row.
        "error_class": error.get("class") if isinstance(error, dict) else None,
        "cost_nano_usd": row["cost_nano_usd"],
        "cost_usd": nano_to_usd_or_none(row["cost_nano_usd"]),
        "occurred_at": row["occurred_at"],
        "received_at": row["received_at"],
        "payload": payload,
    }


# ── Static hosting for the browser app ──────────────────────────────────
# The same bundle the Express twin serves, so :4200 is a complete app on its
# own. `pnpm dev:web:python` runs Vite against this process instead when you
# want hot reload.

WEB_ROOT = HERE.parent / "app" / "web" / "dist"
if (WEB_ROOT / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=WEB_ROOT / "assets"), name="assets")


@app.get("/{asset_path:path}", include_in_schema=False)
def browser_app(asset_path: str):
    # The API and the webhook route are matched above; anything still reaching
    # here that looks like one is a real 404 and must not be answered with a
    # page.
    if asset_path.startswith(("api/", "webhooks/")):
        raise not_found("route_not_found", "No such endpoint.")
    if not (WEB_ROOT / "index.html").is_file():
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "code": "browser_app_not_built",
                    "message": "The browser app is not built yet.",
                    "hint": "Run: pnpm --filter @acme/app build",
                }
            },
        )
    # Client-side routes resolve to the same document.
    candidate = (WEB_ROOT / asset_path).resolve()
    if asset_path and candidate.is_file() and WEB_ROOT.resolve() in candidate.parents:
        return FileResponse(candidate)
    return FileResponse(WEB_ROOT / "index.html")


if __name__ == "__main__":
    import uvicorn

    if not WEBHOOK_SECRET:
        log.warning(
            "PY_APP_WEBHOOK_SECRET is not set: billing events will be rejected."
        )
    uvicorn.run(app, host="127.0.0.1", port=PORT)
