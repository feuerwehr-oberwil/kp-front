"""Dump the FastAPI OpenAPI schema to a file — the committed API contract integrators
can read without a running server (the live /docs is dev-only unless EXPOSE_API_DOCS=true).

    uv run python -m app.dump_openapi [output.json]   # default: ../docs/openapi.json
    just openapi

``app.openapi()`` builds the schema from every registered route regardless of whether the
HTTP /openapi.json endpoint is exposed, so this works in any environment.
"""

import json
import sys
from pathlib import Path

from .main import app

_DEFAULT = Path(__file__).resolve().parents[2] / "docs" / "openapi.json"


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else _DEFAULT
    schema = app.openapi()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(schema, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    paths = len(schema.get("paths", {}))
    info = schema.get("info", {})
    print(f"✓ Wrote {info.get('title')} {info.get('version')} OpenAPI ({paths} paths) → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
