"""The one shape every secret-gated surface uses: 403 when off, 401 when wrong.

Half a dozen surfaces are guarded by a single long-lived secret rather than a login — the
alarm intake, the Divera and FireHub webhooks, the Traccar fake feed, the print relay, the
statistics export, the Erfassungs-Poster. Each of them read its secret, refused with a 403
when none was configured, accepted the token from a query parameter or a header, compared it
in constant time and answered 401 otherwise: the same eight lines, written out eight times.

The rule they encode is a security decision and must not drift, so it lives here once:

* **No secret configured → 403, always.** Fail CLOSED. A surface whose secret was never set
  is switched off, not open — the missing secret IS the deployment's «not enabled» answer.
* **Wrong or missing token → 401**, compared with ``compare_digest`` so a wrong token takes
  the same time as a right one.

What stays with the caller is what genuinely differs per surface: where the secret comes from
(a cached credential, a column on the deployment-config row) and what a refusal says, in
German, in the words that surface uses for itself.
"""

import secrets
from dataclasses import dataclass

from fastapi import HTTPException, Request, status


@dataclass(frozen=True)
class SecretGate:
    """One secret-gated surface: where a token may travel and what a refusal says.

    Declared once per surface as a module-level constant next to the routes it guards, so the
    German wording of a 403/401 is read where the endpoint is read.
    """

    #: 403 body when no secret is configured at all.
    disabled_detail: str
    #: 401 body when a token was offered but is missing or wrong.
    invalid_detail: str
    #: Query parameter carrying the token, for senders that cannot set a header — an alerting
    #: system with a fixed payload can still put ``?secret=…`` in the target URL it is given.
    #: ``None`` for a surface whose only caller is a program we ship (the print agent): there
    #: the header is the whole convention, and a URL-borne secret would only leak into logs.
    query_param: str | None = None

    def check(self, expected: str | None, provided: str | None) -> None:
        """Refuse unless ``provided`` is the configured secret. See the module docstring."""
        if not expected:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=self.disabled_detail)
        if not provided or not secrets.compare_digest(provided, expected):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=self.invalid_detail)

    def check_request(self, expected: str | None, request: Request, header_token: str | None) -> None:
        """Same check for the usual handler shape: query parameter first, then the header."""
        from_query = request.query_params.get(self.query_param) if self.query_param else None
        self.check(expected, from_query or header_token)
