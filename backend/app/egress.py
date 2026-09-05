"""Where this server may send an outbound request when a CALLER picked the destination.

Two places let a request body name a URL the server then talks to: the Rapport's base-tile
template (``app/kroki.py``) and a browser's Web-Push endpoint (``app/api/push.py``). Both are
reachable by any logged-in user, so both are request-forwarding surfaces unless the destination
is constrained — the report tiles additionally resolve against a provider table, this module is
the floor underneath it.

⚠️ NOT the same question as ``credentials._is_local_host``. That one asks «is this the station's
own LAN, so may an ADMIN point us at it over plain http?» and deliberately treats the
link-local range as public. Here the answer must be the opposite on every count: link-local is
where the cloud metadata service lives, and the caller is an ordinary user, not an admin.

Deliberately no proxy/pinned-socket machinery. DNS is checked once, at registration; a rebind
between that check and the send is not defended against, which is the accepted residual risk of
keeping this proportionate (the destinations that survive the check are public-internet hosts,
and the push body itself is encrypted to the subscription's own keys).
"""

import ipaddress
import logging
import socket
from urllib.parse import unquote, urlsplit

logger = logging.getLogger(__name__)


class EgressRefusedError(ValueError):
    """A caller-supplied destination this server refuses to talk to. The message is meant for
    an operator (it reaches the API as a 422 detail), so it says what was refused, not why."""


#: Name suffixes that never leave the local network, whatever DNS answers.
_LOCAL_SUFFIXES = (".local", ".localhost", ".internal", ".home.arpa", ".lan", ".intranet")

#: The well-known NAT64 prefix (RFC 6052). An address in it wraps an IPv4 destination in its low
#: 32 bits, so `64:ff9b::7f00:1` reaches 127.0.0.1 — but the IPv6 literal itself reads as global,
#: which slipped a NAT64-wrapped loopback/private target past the check.
_NAT64_PREFIX = ipaddress.IPv6Network("64:ff9b::/96")


def _blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Everything that is not a routable public address — private ranges, loopback, link-local
    (169.254.169.254 is the metadata service), multicast, reserved and the unspecified address.
    An IPv4-mapped or NAT64-wrapped IPv6 literal is judged as the IPv4 address it carries."""
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif ip in _NAT64_PREFIX:
            ip = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return not ip.is_global or ip.is_multicast


def _resolved_addresses(host: str) -> list[str]:
    """Every address `host` currently resolves to; empty when it does not resolve.

    Split out so a test can stand in for the resolver — and so an unresolvable name is a
    distinguishable case: it is NOT treated as blocked (a push service that is briefly
    unresolvable is not an internal target), only a name that resolves INWARDS is.
    """
    try:
        return [str(info[4][0]) for info in socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)]
    except OSError:
        return []


def is_blocked_host(host: str, *, resolve: bool = False, block_unresolved: bool = False) -> bool:
    """Would a request to this host stay inside the network the server sits in?

    ``resolve=True`` additionally asks the resolver, so a public NAME pointing at 10.x is
    caught too. A bare name with no dot is a LAN name («intranet», «printer») and is refused
    without asking anyone.

    ``block_unresolved`` decides the empty-DNS case: a name that resolves to NOTHING is tolerated
    at registration (a push service can be briefly unresolvable) but refused on a send path that
    opts in — a name with no address is not one this server should be POSTing to.
    """
    # Percent-DECODE before judging. httpx/`requests` normalise `%31%32%37.0.0.1` to `127.0.0.1`
    # at send time, so a host left encoded would slip past as an opaque NAME (DNS fails →
    # «empty, not blocked») and then reach loopback anyway (SEC-09, 05.09.). Decoding here means
    # the policy sees the same host the transport eventually will.
    h = unquote((host or "").strip()).strip().strip("[]").rstrip(".").lower()
    if not h:
        return True
    try:
        return _blocked_ip(ipaddress.ip_address(h))
    except ValueError:
        pass
    if h == "localhost" or h.endswith(_LOCAL_SUFFIXES) or "." not in h:
        return True
    if resolve:
        addrs = _resolved_addresses(h)
        if not addrs:
            return block_unresolved
        return any(_blocked_ip(ipaddress.ip_address(a)) for a in addrs)
    return False


def require_public_https(url: str, *, what: str, resolve: bool = False, block_unresolved: bool = False) -> str:
    """The destination policy in one call: https, no credentials in the URL, the default port,
    and a host on the public internet. Returns the hostname; raises :class:`EgressRefusedError`.

    The port is pinned to 443 rather than merely «not 22/25/…»: every destination this server
    picks up from a caller is an ordinary public https service, and an off-port URL is the shape
    an internal service takes far more often than a real one.
    """
    try:
        parts = urlsplit(url.strip())
        scheme, username, password = parts.scheme, parts.username, parts.password
        port = parts.port  # urlsplit defers netloc parsing; an unparseable port raises here
        host = parts.hostname or ""
    except ValueError as e:
        # A malformed authority — an unclosed IPv6 bracket, a bad port — must be a clean refusal,
        # not a bare ValueError that turns a crafted tile/push URL into a 500 (SEC-03, 05.09.).
        raise EgressRefusedError(f"{what}: ungültige Adresse.") from e
    if scheme != "https":
        raise EgressRefusedError(f"{what}: nur https:// ist erlaubt.")
    if username or password:
        raise EgressRefusedError(f"{what}: eine URL mit Zugangsdaten wird nicht akzeptiert.")
    if port not in (None, 443):
        raise EgressRefusedError(f"{what}: nur der Standard-Port 443 ist erlaubt.")
    if is_blocked_host(host, resolve=resolve, block_unresolved=block_unresolved):
        raise EgressRefusedError(f"{what}: diese Adresse liegt nicht im öffentlichen Internet.")
    return host
