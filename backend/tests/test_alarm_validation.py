"""The alarm-bearing Trupp fields a workspace write must get right — see app/alarm_validation."""

import pytest

from app.alarm_validation import validate_trupp


def test_a_trupp_number_is_a_whole_nonnegative_number_or_absent():
    validate_trupp({"id": "t1", "no": 3})
    validate_trupp({"id": "t1"})  # a record from before 12.09.
    for bad in ("3", 2.5, -1, True):
        with pytest.raises(ValueError, match="no:"):
            validate_trupp({"id": "t1", "no": bad})
