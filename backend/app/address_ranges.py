"""The addresses an object's NAME covers — «Stallenmattstrasse 2-14, Kaibmattweg 1-5 (EH)».

Many station objects are named by the row of houses they are: «Hohestrasse 136-158», «Auf der
Wacht 14&16», «Bruderholzstrasse 90-130, Lettenhofstrasse 30-66». The station's plan outlines
every one of those buildings; the Karte drew one point (owner, review round 3, 17.10.2026: «a lot
of buildings are actually highlighted on the map, the point only indicates a single position»).
This module reads such a name into street + house-number specs and says which register address
a spec covers; app/object_footprints turns the matching addresses into their buildings.

Pure — no I/O. The rules (tests/test_address_ranges.py pins them on the station's real names):

* an item is a street (one to four words, no digits) followed by a number spec: ``14``, ``14a``,
  ``2-14``, ``128a-b``, ``14&16``, ``2, 4``, ``2 und 4`` — a comma continues the list only when a
  number follows it («Stallenmattstrasse 2-14, Kaibmattweg 1-5» is two items);
* a name counts only when it holds a RANGE or a LIST somewhere (``parse`` returns ``[]`` for
  «Hof Thürkauf, Im Buech 15, Im Buech 20» or «Sägestrasse 9»: single addresses are the point's
  business — the area/parcel/building rule — not a row of houses). Once one item is a range or
  a list, every item of the name counts («Amselstrasse 24-32, Auf der Wacht 2» → 2 as well);
* a number covers its lettered siblings (``14`` → 14, 14a, 14b …), a range every number in it
  that EXISTS (``1-14`` → 2, 2a, 3 …, 10a, 14 — never assumed odd or even), a lettered end only
  its letters (``128a-b`` → 128a, 128b; ``134f`` → 134f only);
* a street matches the register's street name case- and accent-insensitively, «str.» read as
  «strasse»; words in front of the street («Garage Keigel Sägestrasse 2») are tried away
  (``street_candidates``).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

#: a range wider than this is not a row of houses (a year span, a typo) — the item is dropped
#: (the station's widest real one: «Bruderholzstrasse 90-130»)
MAX_SPAN = 100
#: a house number above this is not one
MAX_NUMBER = 9999

_NUM = r"\d{1,4}\s?[a-zA-Z]?(?![\w])"
_SEP = r"\s*(?:-|–|&|\+|/|,|\bund\b)\s*"
#: a street: up to four words without digits, the first capitalised, ending right before a number
_ITEM = re.compile(
    r"(?P<street>(?:[A-ZÄÖÜ][\w.'’\-]*)(?:\s+[\wäöüÄÖÜéèàß.'’\-]+){0,3}?)\s+"
    r"(?P<nums>\d{1,4}\s?[a-zA-Z]?(?:" + _SEP + r"(?:\d{1,4}\s?[a-zA-Z]?|[a-zA-Z])(?![\w]))*)(?![\w])"
)
_PART = re.compile(r"\s*(?:,|&|\+|/|\bund\b)\s*")
_RANGE = re.compile(r"^(\d{1,4})\s?([a-zA-Z]?)\s*[-–]\s*(\d{1,4})?\s?([a-zA-Z]?)$")
_ONE = re.compile(r"^(\d{1,4})\s?([a-zA-Z]?)$")
_HOUSE = re.compile(r"^\s*(\d{1,4})\s*([a-zA-Z]?)\b")


@dataclass(frozen=True)
class Numbers:
    """One house-number item: ``lo``–``hi`` (equal for one number), with the letters it is
    limited to (``None`` = any letter or none)."""

    lo: int
    hi: int
    letters: tuple[str, ...] | None = None

    def covers(self, number: int, letter: str) -> bool:
        if not self.lo <= number <= self.hi:
            return False
        return self.letters is None or letter.lower() in self.letters

    @property
    def many(self) -> bool:
        return self.hi > self.lo or (self.letters is not None and len(self.letters) > 1)

    def key(self) -> str:
        span = str(self.lo) if self.lo == self.hi else f"{self.lo}-{self.hi}"
        return span + ("" if self.letters is None else "".join(self.letters))


@dataclass(frozen=True)
class Spec:
    """A street and the numbers of it the name covers."""

    street: str
    numbers: tuple[Numbers, ...]

    @property
    def many(self) -> bool:
        """a range or a list — what makes a name a row of houses"""
        return len(self.numbers) > 1 or any(n.many for n in self.numbers)

    def key(self) -> str:
        return f"{fold(self.street)}:{','.join(n.key() for n in self.numbers)}"


def fold(s: str) -> str:
    """lower case, accents off, «str.» → «strasse», one space — how streets are compared."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"(?<=\w)str\.?(?=\s|$)", "strasse", s.lower())
    return re.sub(r"\s+", " ", s).strip(" .")


def _letters(a: str, b: str) -> tuple[str, ...]:
    lo, hi = sorted((a.lower(), b.lower()))
    return tuple(chr(c) for c in range(ord(lo), ord(hi) + 1))


def _numbers(spec: str) -> list[Numbers]:
    """«2-14» / «14&16» / «128a-b» / «2, 4» → the items; an unreadable or absurd item is dropped."""
    out: list[Numbers] = []
    for part in _PART.split(spec.strip()):
        part = part.strip()
        if not part:
            continue
        if m := _ONE.match(part):
            n, letter = int(m.group(1)), m.group(2).lower()
            if 0 < n <= MAX_NUMBER:
                out.append(Numbers(n, n, (letter,) if letter else None))
            continue
        if m := _RANGE.match(part):
            lo, la, hi, lb = int(m.group(1)), m.group(2), m.group(3), m.group(4)
            if hi is None:  # «128a-b»: a run of letters on one number
                if la and lb:
                    out.append(Numbers(lo, lo, _letters(la, lb)))
                continue
            hi_n = int(hi)
            if lo == hi_n and la and lb:
                out.append(Numbers(lo, lo, _letters(la, lb)))
            elif 0 < lo < hi_n <= MAX_NUMBER and hi_n - lo <= MAX_SPAN:
                out.append(Numbers(lo, hi_n))
            continue
        if len(part) == 1 and part.isalpha() and out and out[-1].lo == out[-1].hi:
            # «134a&b»: a bare letter after a number is that number's next letter
            prev = out[-1]
            out[-1] = Numbers(prev.lo, prev.hi, tuple(sorted({*(prev.letters or ()), part.lower()})))
    return out


def parse(*texts: str | None) -> list[Spec]:
    """The address specs in an object's name (and aliases, e.g. its plan folder «<address> -
    <name>»). ``[]`` unless one of them holds a range or a list — see the module header."""
    found: dict[str, Spec] = {}
    for text in texts:
        for chunk in re.split(r"\s+-\s+|\(|\)|;", text or ""):
            for m in _ITEM.finditer(chunk):
                nums = tuple(_numbers(m.group("nums")))
                street = m.group("street").strip(" ,.")
                if not nums or not street or not re.search(r"[a-zA-ZäöüÄÖÜ]{3}", street):
                    continue
                spec = Spec(street, nums)
                key = spec.key()
                if key not in found:
                    found[key] = spec
    specs = list(found.values())
    return specs if any(s.many for s in specs) else []


def street_candidates(street: str) -> list[str]:
    """The street as written and with leading words dropped, longest first: «Garage Keigel
    Sägestrasse» → [«Garage Keigel Sägestrasse», «Keigel Sägestrasse», «Sägestrasse»]."""
    words = street.split()
    return [" ".join(words[i:]) for i in range(len(words)) if len(" ".join(words[i:])) >= 3]


def query_names(street: str) -> list[str]:
    """The street names to ask the register for: every candidate, «…str.» written out."""
    out: list[str] = []
    for c in street_candidates(street):
        for v in (c, re.sub(r"(?<=\w)str\.?$", "strasse", c)):
            if v not in out:
                out.append(v)
    return out


def house(number: str | None) -> tuple[int, str] | None:
    """The register's house number «10a» → (10, "a"); None when it has none."""
    m = _HOUSE.match(number or "")
    return (int(m.group(1)), m.group(2).lower()) if m else None


def settle(specs: list[Spec], register_streets: list[str]) -> list[Spec]:
    """Each spec on the LONGEST of its street candidates the register knows (so «Auf der Wacht»
    never falls back to a street called «Wacht» when «Auf der Wacht» exists); a spec whose street
    the register does not know at all is dropped."""
    known = {fold(s): s for s in register_streets}
    out: list[Spec] = []
    for spec in specs:
        hit = next((known[fold(q)] for q in query_names(spec.street) if fold(q) in known), None)
        if hit is not None:
            out.append(Spec(hit, spec.numbers))
    return out


def covers(specs: list[Spec], street: str, number: str | None) -> bool:
    """Does any spec cover this register address? (The street compared folded — run the specs
    through ``settle`` first when they come from a name with words in front of the street.)"""
    h = house(number)
    if h is None:
        return False
    s = fold(street)
    return any(fold(spec.street) == s and any(n.covers(*h) for n in spec.numbers) for spec in specs)


def specs_key(specs: list[Spec]) -> str:
    """One stable string for a set of specs (what a stored answer was asked for)."""
    return ";".join(sorted(s.key() for s in specs))
