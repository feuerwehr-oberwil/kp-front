"""Source identity for rate limiting — who the request actually came from.

A throttle is only as good as the key it counts against. `X-Forwarded-For` is a plain request
header: a client talking to the app directly can write whatever it likes into it, and a limiter
keyed on the first value it finds hands that client an unlimited supply of fresh buckets
(security audit SEC-08).

The rule here is the standard one, and it needs no configuration to be safe: walk the forwarded
chain from the RIGHT and take the first address we do not recognise as infrastructure. A proxy
*appends* the peer it saw, so the rightmost untrusted entry is the closest real client, and
anything a caller prepended sits to the left of it and is never reached. "Infrastructure" is
loopback plus the private/link-local/unique-local ranges — Railway's edge, a Caddy in front of
the container and a docker-compose network all reach the app from one of those, and no client
on the public internet does. When the direct peer is itself public, nothing in the chain is
trusted and the peer is the answer.

Consequence worth naming: on a station LAN with no proxy at all, every device is a "trusted"
private peer, so a device there can name its own bucket. That is a host on the station's own
network, which is not the traffic this brake exists for.
"""

import ipaddress

from fastapi import Request

#: Answer for a request with no peer at all (ASGI servers may omit `client`). One shared
#: bucket is the safe direction: unattributable traffic throttles together.
UNKNOWN_SOURCE = "unknown"


def _caller_address(value: str) -> str | None:
    """The address, if it is a parseable one belonging to a caller rather than to a hop.

    An IPv4-mapped IPv6 literal is unwrapped so a proxy writing "::ffff:198.51.100.4" and one
    writing "198.51.100.4" name the same bucket.
    """
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return None
    return str(ip)


def client_ip(request: Request) -> str:
    """The rate-limiting key for this request's source (never trusted for authorization)."""
    peer = request.client.host if request.client else None
    if peer is None:
        return UNKNOWN_SOURCE
    direct = _caller_address(peer)
    if direct is not None:
        # Talking to us directly: its own address is the only thing it cannot forge.
        return direct

    forwarded = request.headers.get("x-forwarded-for", "")
    for hop in reversed([h.strip() for h in forwarded.split(",") if h.strip()]):
        caller = _caller_address(hop)
        if caller is not None:
            return caller
    return peer
