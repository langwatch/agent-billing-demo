"""The whole request-path integration. This is the point of the demo: the app
talks to the LangWatch gateway exactly like it talks to OpenAI. The only
differences from a direct OpenAI call:

- ``base_url`` points at the gateway.
- ``api_key`` is the TENANT's virtual key secret, so every request is
  attributed (and budgeted) to that tenant.
- the OpenAI ``user`` field carries the end-user id, so per-user budgets apply
  and every spend event carries the id. Nothing else is needed for
  attribution.
"""

import os
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, List, Optional

from openai import APIStatusError, AsyncOpenAI

GATEWAY_URL = os.environ.get("LANGWATCH_GATEWAY_URL", "http://localhost:5561")

#: The models the agent builder offers. Any gateway model id works.
MODELS = (
    "openai/gpt-5-mini",
    "openai/gpt-5",
    "anthropic/claude-haiku-4-5-20251001",
)

#: A request that hangs is worse than one that fails, so bound it.
REQUEST_TIMEOUT_SECONDS = 60

#: The gateway stamps this on every answered request. It is the same
#: identifier that keys every billing event and reconciliation row, so storing
#: it next to the message joins the transcript straight to the invoice.
#:
#: A REFUSED request (a 402, say) carries the id on ``X-Request-Id`` only, so
#: correlating a rejection to its billing event reads that one instead.
REQUEST_ID_HEADER = "x-langwatch-gateway-request-id"


class ChatStream:
    """One answered request, still streaming.

    The gateway decides a request BEFORE any token: a breached cap comes back
    as a 402 from the create call, not as an empty stream. So the request id is
    known up front, and by the time this object exists the request has been
    admitted. Token counts fill in as the stream ends.
    """

    def __init__(self, raw: Any) -> None:
        self._raw = raw
        self.gateway_request_id: Optional[str] = raw.headers.get(REQUEST_ID_HEADER)
        self.input_tokens: Optional[int] = None
        self.output_tokens: Optional[int] = None

    async def deltas(self) -> AsyncIterator[str]:
        async for chunk in self._raw.parse():
            # The usage chunk arrives last and carries no choices.
            if chunk.usage is not None:
                self.input_tokens = chunk.usage.prompt_tokens
                self.output_tokens = chunk.usage.completion_tokens
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content


async def open_chat_stream(
    *,
    virtual_key_secret: str,
    model: str,
    system_prompt: str,
    history: List[Dict[str, str]],
    end_user_id: str,
) -> ChatStream:
    """Start one completion on the tenant's key, attributed to one seat.

    ``history`` is the conversation so far, oldest first, excluding the system
    prompt. A refusal raises ``APIStatusError`` here, which is what lets the
    caller answer with a plain JSON error instead of an error inside a stream
    that has already claimed a 200.
    """
    client = AsyncOpenAI(
        base_url=f"{GATEWAY_URL}/v1",
        api_key=virtual_key_secret,
        max_retries=1,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    # The raw response is taken so the gateway request id can be read off the
    # headers; `parse()` hands back the ordinary stream of chunks.
    raw = await client.chat.completions.with_raw_response.create(
        model=model,
        messages=[{"role": "system", "content": system_prompt}, *history],
        # This one field is the whole attribution contract.
        user=end_user_id,
        stream=True,
        stream_options={"include_usage": True},
    )
    return ChatStream(raw)


@dataclass
class GatewayFailure:
    #: OpenAI-compatible discriminant. Always equal to ``code``.
    type: str
    code: str
    message: str
    #: Machine-readable detail for this code. Values are arbitrary JSON, not
    #: just strings: a 402 carries ``budget_id`` / ``budget_scope`` /
    #: ``budget_window`` as strings, a 400 carries ``reasons`` as a list of
    #: ``{code, message, meta?}``. Read a key with ``meta_string`` when you
    #: expect a string; keep the rest as it arrived rather than dropping it.
    meta: Dict[str, Any]


def read_gateway_failure(error: Exception) -> Optional[GatewayFailure]:
    """Read the canonical error envelope off a failed gateway call.

    One shape, everywhere on the wire::

        {"error": {"type": ..., "code": ..., "message": ..., "meta": {...}}}

    ``type`` and ``code`` always carry the same value. Returns None when the
    body carries no ``error`` object, which means this is not a LangWatch
    refusal at all and belongs on the generic upstream path.

    Verified against the live gateway: a breached cap answers 402 with this
    envelope and lowercase snake values in ``meta``.
    """
    if not isinstance(error, APIStatusError):
        return None
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
    return GatewayFailure(
        type=inner["type"] if isinstance(inner.get("type"), str) else code,
        code=code,
        message=inner["message"] if isinstance(inner.get("message"), str) else code,
        meta=meta if isinstance(meta, dict) else {},
    )


def meta_string(meta: Dict[str, Any], key: str) -> Optional[str]:
    """One ``meta`` value, when the code documents that key as a string."""
    value = meta.get(key)
    return value if isinstance(value, str) and value else None
