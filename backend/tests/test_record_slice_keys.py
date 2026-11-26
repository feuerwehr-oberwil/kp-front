"""The ``el`` record slice's allowlist is one file both sides read (app/data/record_slice_keys.json).

The client sends exactly ``RECORD_SLICE_KEYS`` (src/lib/api/workspaceSync.ts, checked against the
same file by src/lib/api/recordSliceKeys.test.ts); the server stores only these keys.
"""

import json
from pathlib import Path

from app.api import incidents


def test_the_record_allowlist_is_the_shared_file():
    path = Path(incidents.__file__).parent.parent / "data" / "record_slice_keys.json"
    keys = json.loads(path.read_text("utf-8"))["keys"]
    assert len(keys) == len(set(keys)), "a key listed twice"
    assert all(isinstance(k, str) and k for k in keys)
    assert frozenset(keys) == incidents.RECORD_WORKSPACE_KEYS
    # the tactical picture stays with the editors (docs/API.md · roles)
    assert not incidents.RECORD_WORKSPACE_KEYS & {"entities", "drawings", "board", "objects", "trupps", "settings"}
