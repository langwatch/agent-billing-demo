"""Load the repository's ``.env`` into the process.

Import this first from any entry point, so every way of starting a process
ends up with the same configuration. A receiver that starts without its
signing secret rejects every delivery it is sent, which is an expensive way
to discover a missing shell export.

Real environment variables always win: a value already set is never
overwritten, so containers and CI keep control.
"""

import os
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def load_env(path: Path = ENV_PATH) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env()
