"""A minimal Mapbox Vector Tile reader — just enough to pull POLYGONS out of one layer.

Used by app/object_footprints to read swisstopo's use areas (swissTLM3D «Nutzungsareal», the
``landuse`` layer of ``ch.swisstopo.base.vt``) at one point. No dependency for a ~100-line
protobuf walk: the spec (https://github.com/mapbox/vector-tile-spec, v2) is small and fixed.

Only what that caller needs: layer by name, a feature's string/number properties, and its
polygon rings in TILE coordinates (0…extent, y down; the caller projects). Points and lines are
skipped. Rings come grouped as polygons — an exterior ring followed by its holes, told apart by
winding as the spec defines it (exterior = positive shoelace area in tile coordinates).
"""

from __future__ import annotations

import gzip
import struct
from collections.abc import Iterator
from dataclasses import dataclass, field

Ring = list[tuple[float, float]]


@dataclass
class Feature:
    properties: dict[str, object] = field(default_factory=dict)
    #: each polygon is [exterior, hole, hole, …] in tile coordinates
    polygons: list[list[Ring]] = field(default_factory=list)


@dataclass
class Layer:
    name: str
    extent: int
    features: list[Feature]


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    out = shift = 0
    while True:
        b = buf[i]
        i += 1
        out |= (b & 0x7F) << shift
        if b < 0x80:
            return out, i
        shift += 7


def _fields(buf: bytes) -> Iterator[tuple[int, int, int | bytes]]:
    """(field number, wire type, value) for every field of one message. Length-delimited values
    come back as bytes, varints as int; 32/64-bit values as their raw bytes."""
    i, n = 0, len(buf)
    while i < n:
        key, i = _varint(buf, i)
        num, wt = key >> 3, key & 7
        v: int | bytes
        if wt == 0:
            v, i = _varint(buf, i)
        elif wt == 2:
            ln, i = _varint(buf, i)
            v, i = buf[i : i + ln], i + ln
        elif wt == 1:
            v, i = buf[i : i + 8], i + 8
        elif wt == 5:
            v, i = buf[i : i + 4], i + 4
        else:  # groups (3/4) are not in the spec
            raise ValueError(f"unsupported wire type {wt}")
        yield num, wt, v


def _b(v: int | bytes) -> bytes:
    if not isinstance(v, bytes):
        raise ValueError("expected a length-delimited field")
    return v


def _i(v: int | bytes) -> int:
    if not isinstance(v, int):
        raise ValueError("expected a varint field")
    return v


def _packed(buf: bytes) -> list[int]:
    out, i = [], 0
    while i < len(buf):
        v, i = _varint(buf, i)
        out.append(v)
    return out


def _zigzag(n: int) -> int:
    return (n >> 1) ^ -(n & 1)


def _value(buf: bytes) -> object:
    for num, _wt, v in _fields(buf):
        if num == 1:
            return _b(v).decode("utf-8", "replace")
        if num == 2:
            return struct.unpack("<f", _b(v))[0]
        if num == 3:
            return struct.unpack("<d", _b(v))[0]
        if num in (4, 5):
            return _i(v)
        if num == 6:
            return _zigzag(_i(v))
        if num == 7:
            return bool(v)
    return None


def _signed_area(r: Ring) -> float:
    s = 0.0
    for i in range(len(r)):
        x1, y1 = r[i - 1]
        x2, y2 = r[i]
        s += x1 * y2 - x2 * y1
    return s / 2


def _polygons(geom: list[int]) -> list[list[Ring]]:
    rings: list[Ring] = []
    x = y = 0
    i = 0
    cur: Ring = []
    while i < len(geom):
        cmd, count = geom[i] & 7, geom[i] >> 3
        i += 1
        if cmd in (1, 2):  # MoveTo / LineTo
            for _ in range(count):
                x += _zigzag(geom[i])
                y += _zigzag(geom[i + 1])
                i += 2
                if cmd == 1:
                    cur = [(x, y)]
                else:
                    cur.append((x, y))
        elif cmd == 7:  # ClosePath
            if len(cur) >= 3:
                rings.append(cur)
            cur = []
        else:
            raise ValueError(f"unknown geometry command {cmd}")
    out: list[list[Ring]] = []
    for r in rings:
        a = _signed_area(r)
        if a > 0 or not out:  # an exterior ring opens a polygon (a stray leading hole does too)
            out.append([r])
        elif a < 0:
            out[-1].append(r)
    return out


def read_layer(data: bytes, name: str) -> Layer | None:
    """The named layer's polygon features, or None when the tile has no such layer."""
    if data[:2] == b"\x1f\x8b":  # some servers hand out the stored gzip as-is
        data = gzip.decompress(data)
    for num, _wt, lraw in _fields(data):
        if num != 3:
            continue
        lbuf = _b(lraw)
        lname, extent = "", 4096
        keys: list[str] = []
        values: list[object] = []
        raw_features: list[bytes] = []
        for lnum, _lwt, v in _fields(lbuf):
            if lnum == 1:
                lname = _b(v).decode()
            elif lnum == 2:
                raw_features.append(_b(v))
            elif lnum == 3:
                keys.append(_b(v).decode())
            elif lnum == 4:
                values.append(_value(_b(v)))
            elif lnum == 5:
                extent = _i(v)
        if lname != name:
            continue
        feats: list[Feature] = []
        for fbuf in raw_features:
            tags: list[int] = []
            geom: list[int] = []
            gtype = 0
            for fnum, _fwt, v in _fields(fbuf):
                if fnum == 2:
                    tags = _packed(_b(v))
                elif fnum == 3:
                    gtype = _i(v)
                elif fnum == 4:
                    geom = _packed(_b(v))
            if gtype != 3:  # POLYGON only
                continue
            props = {keys[tags[k]]: values[tags[k + 1]] for k in range(0, len(tags) - 1, 2)}
            feats.append(Feature(properties=props, polygons=_polygons(geom)))
        return Layer(name=lname, extent=extent, features=feats)
    return None
