"""The ACME Agents app shell, python edition: the same deliberately small
agent-platform SaaS as ``app/`` (TypeScript), built on FastAPI and the
official LangWatch python SDK. Customers sign up, add users, create
agents, and chat; every chat call goes through the LangWatch gateway on
the customer's virtual key with the end user attributed, so metering,
budgets, and billing events need no metering code here.

This app also hosts its own webhook receiver on ``/webhooks/langwatch``
(register it as its own endpoint; see the README), reusing the same
ledger and signature modules the standalone receiver uses, so the python
stack is one process end to end.

Run::

    .venv/bin/uvicorn app:app --port 4200

Needs in the environment: LANGWATCH_API_KEY, LANGWATCH_PROJECT_ID,
LANGWATCH_BASE_URL, LANGWATCH_GATEWAY_URL, PY_APP_WEBHOOK_SECRET.
"""

import env  # noqa: F401  (loads .env before anything reads it)

import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, Optional

import langwatch
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from openai import APIStatusError, OpenAI
from pydantic import BaseModel

from ledger import Ledger
from verify_signature import DELIVERY_ID_HEADER, verify_signature

PORT = int(os.environ.get("APP_PY_PORT", "4200"))
BASE_URL = os.environ.get("LANGWATCH_BASE_URL", "http://localhost:5560")
GATEWAY_URL = os.environ.get("LANGWATCH_GATEWAY_URL", "http://localhost:5561")
API_KEY = os.environ.get("LANGWATCH_API_KEY", "")
WEBHOOK_SECRET = os.environ.get("PY_APP_WEBHOOK_SECRET", "")

langwatch.setup(api_key=API_KEY, endpoint_url=BASE_URL, skip_open_telemetry_setup=True)

HERE = Path(__file__).parent
app = FastAPI(title="ACME Agents (python)")
ledger = Ledger(str(HERE / "app_py.ledger.sqlite"))


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(HERE / "app_py.sqlite")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            virtual_key_id TEXT NOT NULL,
            virtual_key_secret TEXT NOT NULL,
            hard_cap_budget_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            email TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            system_prompt TEXT NOT NULL,
            model TEXT NOT NULL
        );
        """
    )
    return conn


class CustomerIn(BaseModel):
    name: str


class UserIn(BaseModel):
    email: str


class AgentIn(BaseModel):
    name: str = "Assistant"
    system_prompt: str = "You are a helpful assistant."
    model: str = "openai/gpt-4o-mini"


class ChatIn(BaseModel):
    agent_id: int
    user_id: int
    message: str


@app.post("/api/customers", status_code=201)
def signup(body: CustomerIn) -> Dict[str, Any]:
    """Create the customer AND provision it on LangWatch: the same four
    SDK calls documented in provision.py. Every enum is lowercase snake in
    and out; uppercase is rejected on create."""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name is required")
    admin = langwatch.gateway_admin
    minted = admin.create_virtual_key(
        name=name, description=f"Tenant key for {name} (acme-agents-py signup)"
    )
    vk_id = minted["virtual_key"]["id"]
    hard_cap = admin.create_budget(
        scope={"kind": "virtual_key", "virtual_key_id": vk_id},
        name=f"{name} hard cap",
        window="manual",
        limit_usd="5.00",
        on_breach="block",
    )
    admin.create_budget(
        scope={"kind": "virtual_key", "virtual_key_id": vk_id},
        name=f"{name} soft cap",
        window="manual",
        limit_usd="2.50",
        on_breach="warn",
    )
    admin.create_budget(
        scope={"kind": "attributed_user", "anchor_virtual_key_id": vk_id},
        name=f"{name} per-user allowance",
        window="month",
        limit_usd="1.00",
        on_breach="block",
    )
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO customers (name, virtual_key_id, virtual_key_secret, hard_cap_budget_id)"
            " VALUES (?, ?, ?, ?)",
            (name, vk_id, minted["secret"], hard_cap["id"]),
        )
        return {"id": cur.lastrowid, "name": name, "virtual_key_id": vk_id}


@app.get("/api/customers")
def customers() -> Dict[str, Any]:
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name, virtual_key_id FROM customers ORDER BY id"
        ).fetchall()
        return {"customers": [dict(r) for r in rows]}


@app.post("/api/customers/{customer_id}/users", status_code=201)
def add_user(customer_id: int, body: UserIn) -> Dict[str, Any]:
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO users (customer_id, email) VALUES (?, ?)",
            (customer_id, body.email.strip()),
        )
        return {"id": cur.lastrowid, "email": body.email.strip()}


@app.post("/api/customers/{customer_id}/agents", status_code=201)
def add_agent(customer_id: int, body: AgentIn) -> Dict[str, Any]:
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO agents (customer_id, name, system_prompt, model) VALUES (?, ?, ?, ?)",
            (customer_id, body.name, body.system_prompt, body.model),
        )
        return {"id": cur.lastrowid}


@app.post("/api/chat")
def chat(body: ChatIn) -> JSONResponse:
    """The request path: the tenant's own virtual key, the OpenAI wire,
    and the `user` field carrying the end user. That one field is the
    whole attribution integration."""
    with db() as conn:
        agent = conn.execute(
            "SELECT * FROM agents WHERE id = ?", (body.agent_id,)
        ).fetchone()
        user = conn.execute(
            "SELECT * FROM users WHERE id = ?", (body.user_id,)
        ).fetchone()
        if not agent or not user:
            raise HTTPException(404, "unknown agent or user")
        customer = conn.execute(
            "SELECT * FROM customers WHERE id = ?", (agent["customer_id"],)
        ).fetchone()

    client = OpenAI(
        base_url=f"{GATEWAY_URL}/v1", api_key=customer["virtual_key_secret"]
    )
    try:
        completion = client.chat.completions.create(
            model=agent["model"],
            messages=[
                {"role": "system", "content": agent["system_prompt"]},
                {"role": "user", "content": body.message},
            ],
            user=user["email"],
        )
        return JSONResponse(
            {
                "reply": completion.choices[0].message.content,
                "model": completion.model,
            }
        )
    except APIStatusError as error:
        details = _gateway_error(error)
        if details and details["code"] == "budget_exceeded":
            meta = details["meta"]
            scope = _meta_string(meta, "budget_scope")
            per_seat = scope == "attributed_user"
            return JSONResponse(
                status_code=402,
                content={
                    "error": (
                        "You have used up your personal AI allowance for this period."
                        if per_seat
                        else "Your organization's AI budget is exhausted for this period."
                    ),
                    "code": details["code"],
                    "budget_scope": scope,
                    "budget_id": _meta_string(meta, "budget_id"),
                    "budget_window": _meta_string(meta, "budget_window"),
                },
            )
        if details and details["code"] == "end_user_required":
            return JSONResponse(
                status_code=400,
                content={
                    "error": "This platform requires end-user attribution on every call.",
                    "code": details["code"],
                },
            )
        raise HTTPException(502, str(error))


def _gateway_error(error: APIStatusError) -> Optional[Dict[str, Any]]:
    """Read the canonical error envelope off a failed gateway call.

    One shape, everywhere on the wire::

        {"error": {"type": ..., "code": ..., "message": ..., "meta": {...}}}

    ``type`` and ``code`` always carry the same value. ``meta`` values are
    arbitrary JSON, not just strings: a 402 carries ``budget_id`` /
    ``budget_scope`` / ``budget_window`` as strings, a 400 carries
    ``reasons`` as a list of ``{code, message, meta?}``. It is kept as it
    arrived and narrowed per key by the caller that knows the key.

    Returns None when the body carries no ``error`` object, which means this
    is not a LangWatch refusal at all and belongs on the generic 502 path.

    TODO-VALIDATE: drive a real 402 through the OpenAI client and confirm
    ``error.response.json()`` carries the canonical envelope with
    ``meta.budget_scope`` / ``budget_id`` / ``budget_window``, lowercase. If
    another shape arrives, that is a wire regression to report, not a shape
    to tolerate here again.
    """
    try:
        envelope = error.response.json()
    except Exception:
        return None
    if not isinstance(envelope, dict):
        return None
    inner = envelope.get("error")
    if not isinstance(inner, dict):
        return None
    code = inner.get("code") or inner.get("type")
    if not isinstance(code, str):
        return None
    meta = inner.get("meta")
    return {
        "type": inner.get("type") if isinstance(inner.get("type"), str) else code,
        "code": code,
        "message": inner["message"] if isinstance(inner.get("message"), str) else code,
        "meta": meta if isinstance(meta, dict) else {},
    }


def _meta_string(meta: Dict[str, Any], key: str) -> Optional[str]:
    """One ``meta`` value, when the code documents that key as a string."""
    value = meta.get(key)
    return value if isinstance(value, str) and value else None


@app.post("/api/customers/{customer_id}/close-period")
def close_period(customer_id: int) -> Dict[str, Any]:
    """Reset moves the manual window's boundary; recorded spend and every
    emitted event stay immutable, so reconciliation is unaffected."""
    with db() as conn:
        customer = conn.execute(
            "SELECT * FROM customers WHERE id = ?", (customer_id,)
        ).fetchone()
    if not customer:
        raise HTTPException(404, "unknown customer")
    langwatch.gateway_admin.reset_budget(
        customer["hard_cap_budget_id"], reason="acme-agents-py period close"
    )
    return {"closed": True}


# ── The receiver: this app ingests its own billing events ───────────────


@app.post("/webhooks/langwatch")
async def receive(request: Request) -> Dict[str, Any]:
    """Same contract as the standalone receivers: verify over the exact
    raw bytes, ingest idempotently, 2xx only after durable ingest.

    ``X-LangWatch-Delivery-Id`` names the DELIVERY, which carries the whole
    batch: a log correlation handle, never the dedup key. Dedup is on the
    envelope ``id`` inside the body, which the ledger owns.
    """
    raw = await request.body()
    signature = request.headers.get("X-LangWatch-Signature", "")
    if not verify_signature(
        raw_body=raw, signature_header=signature, secret=WEBHOOK_SECRET
    ):
        raise HTTPException(401, "bad signature")
    delivery_id = request.headers.get(DELIVERY_ID_HEADER, "unknown")
    batch = json.loads(raw).get("batch", [])
    outcomes = [ledger.ingest(envelope) for envelope in batch]
    ingested = sum(1 for o in outcomes if o == "ingested")
    print(f"[{delivery_id}] {len(batch)} delivered, {ingested} new")
    return {"received": len(batch), "ingested": ingested}


@app.get("/api/customers/{customer_id}/billing")
def billing(customer_id: int) -> Dict[str, Any]:
    """The local ledger this app's receiver fed: what WE will invoice,
    joined per end user, straight from webhook events."""
    with db() as conn:
        customer = conn.execute(
            "SELECT * FROM customers WHERE id = ?", (customer_id,)
        ).fetchone()
    if not customer:
        raise HTTPException(404, "unknown customer")
    return {
        "virtual_key_id": customer["virtual_key_id"],
        "by_end_user": ledger.totals_by_end_user(customer["virtual_key_id"]),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT)
