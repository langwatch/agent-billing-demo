"""The port a process binds and the URL it advertises must name the same
listener.

A shell script that expands ``${APP_PY_PORT:-4200}`` is reading the shell's
environment, not ``.env``, so a process can bind the port ``.env`` names while
telling LangWatch to deliver to the default one. Deliveries then go to a port
nothing is listening on, and the symptom is a webhook that never arrives
rather than a number that disagrees. Every entry point states both and refuses
to start when they disagree.
"""

from urllib.parse import urlparse

LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def is_loopback_host(hostname: str) -> bool:
    return hostname in LOOPBACK_HOSTS


def assert_advertised_port_matches(
    *, label: str, bound_port: int, advertised_url: str
) -> None:
    print(f"[{label}] bound port {bound_port}, advertised {advertised_url}")

    parsed = urlparse(advertised_url)
    if not parsed.scheme or not parsed.hostname:
        raise SystemExit(
            f"{label}: {advertised_url} is not a valid URL. Fix the public URL in .env."
        )

    # A tunnel or a public hostname legitimately names another port: it is
    # some other listener forwarding here. Only a loopback URL is claiming to
    # be this very process, so only that claim can be checked.
    if not is_loopback_host(parsed.hostname):
        return

    advertised_port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if advertised_port == bound_port:
        return

    raise SystemExit(
        f"{label}: advertised {advertised_url} but bound port {bound_port}. "
        "Point the port and the public URL at the same listener in .env "
        "(APP_PORT with APP_PUBLIC_URL, APP_PY_PORT with APP_PY_PUBLIC_URL)."
    )
