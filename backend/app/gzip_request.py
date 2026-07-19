"""Transparent gzip REQUEST-body inflation (pure ASGI).

The frontend compresses large JSON bodies (workspace saves) with ``Content-Encoding: gzip``
— repetitive JSON shrinks ~8–10×, which matters on field LTE. Starlette has response
compression built in but nothing for request bodies, so this middleware inflates them
before the app sees the request. Two size guards apply: the existing Content-Length cap
in main.py bounds the WIRE size, and this middleware bounds the DECOMPRESSED size so a
gzip bomb can't expand past the JSON body cap.
"""

import json
import zlib


class GzipRequestMiddleware:
    def __init__(self, app, max_decompressed_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_decompressed_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        if headers.get(b"content-encoding", b"").lower() != b"gzip":
            await self.app(scope, receive, send)
            return

        # Stream-decompress with a hard output cap: gzip compresses up to ~1000×, so the
        # cap must be enforced DURING inflation — a full gzip.decompress() of a 10 MB bomb
        # would materialise gigabytes before any length check could run.
        inflater = zlib.decompressobj(wbits=31)  # 31 = gzip container
        parts: list[bytes] = []
        total = 0
        try:
            while True:
                msg = await receive()
                if msg["type"] != "http.request":
                    await self._reject(send, 400, "Ungültiger gzip-Request")
                    return
                chunk = msg.get("body", b"")
                if chunk:
                    out = inflater.decompress(chunk, self.max_bytes + 1 - total)
                    total += len(out)
                    if total > self.max_bytes or inflater.unconsumed_tail:
                        await self._reject(
                            send, 413, f"Anfrage zu gross (max. {self.max_bytes // (1024 * 1024)} MB)"
                        )
                        return
                    parts.append(out)
                if not msg.get("more_body", False):
                    break
            parts.append(inflater.flush())
        except zlib.error:
            await self._reject(send, 400, "Ungültige gzip-Kodierung")
            return
        body = b"".join(parts)
        if len(body) > self.max_bytes:
            await self._reject(send, 413, f"Anfrage zu gross (max. {self.max_bytes // (1024 * 1024)} MB)")
            return

        # rewrite the scope so downstream sees a plain request with the true length
        new_headers = [
            (k, v)
            for k, v in scope["headers"]
            if k.lower() not in (b"content-encoding", b"content-length")
        ]
        new_headers.append((b"content-length", str(len(body)).encode()))
        scope = dict(scope, headers=new_headers)

        delivered = False

        async def inflated_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()  # pass through disconnects

        await self.app(scope, inflated_receive, send)

    @staticmethod
    async def _reject(send, status: int, detail: str) -> None:
        payload = json.dumps({"detail": detail}).encode()
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": payload})
