"""URL credential redaction shared by logging and the operator diagnostics export."""

import re

#: Query parameters whose VALUE is a credential, as they appear in a URL anywhere in a log
#: line. `accesskey` is Divera's own spelling; `secret` is how both webhook intakes and the
#: capture/stats links accept theirs (`?secret=…`), which uvicorn's access log writes out in
#: full on every legitimate call.
_SECRET_QUERY_PARAM = re.compile(
    r"(?i)([?&](?:accesskey|access_key|api_key|apikey|key|secret|token|t|password|passwd|pwd))=[^&\s'\"]*"
)
_SECRET_LINK_PATH = re.compile(r"(/(?:e|l)/)[^/?#\s'\"]+")


def redact_url_credentials(value: str) -> str:
    """Remove query credentials and QR bootstrap secrets from any URL in diagnostic text."""
    return _SECRET_LINK_PATH.sub(r"\1<redacted>", _SECRET_QUERY_PARAM.sub(r"\1=<redacted>", value))
