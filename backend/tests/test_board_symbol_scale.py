"""The board symbol's printed size is derived from a number that lives in the frontend – this
fails when the two drift.

`_BOARD_SYMBOL_PX` is the unscaled base a plan symbol gets from its sheet (~42 px on a single
A4 portrait) times the DEFAULT of the plan surface's Symbolgrösse. That default is a frontend
constant (`SYMBOL_SCALE.board.default` in src/lib/prefs.ts) and it has been changed once
already: on 27.08. it went 1.0 → 0.7 without this side following, and the Rapport's plan page
printed its symbols ~43 % larger than the board on screen showed them.

⚠️ NOT the device's slider position, which deliberately never reaches the paper (see
src/lib/krokiPayload.ts). Only the default – the app's own opinion of the right size – is
mirrored here.

Skipped when the repo root isn't present (running inside the production image, where only
backend/ is copied).
"""

import pathlib
import re

import pytest

from app.kroki import _BOARD_SYMBOL_PX

ROOT = pathlib.Path(__file__).resolve().parents[2]
PREFS = ROOT / "src" / "lib" / "prefs.ts"

pytestmark = pytest.mark.skipif(not PREFS.exists(), reason="repo root not available (running from the image)")

#: the on-screen base, before the multiplier — Whiteboard.tsx · symBase (`fit.w * 0.085`)
UNSCALED_BASE_PX = 42


def test_board_symbol_scale_mirrors_prefs():
    m = re.search(r"board:\s*\{[^}]*?default:\s*([0-9.]+)", PREFS.read_text())
    assert m, "SYMBOL_SCALE.board.default not found in src/lib/prefs.ts — did the shape change?"
    default = float(m.group(1))

    assert pytest.approx(UNSCALED_BASE_PX * default) == _BOARD_SYMBOL_PX, (
        f"kroki._BOARD_SYMBOL_PX is {_BOARD_SYMBOL_PX}, but prefs.ts says the plan surface "
        f"defaults to {default}× — paper and screen would disagree by "
        f"{abs(_BOARD_SYMBOL_PX / (UNSCALED_BASE_PX * default) - 1) * 100:.0f} %."
    )
