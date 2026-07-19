"""Manual smoke test for the auth flow (run against a live server on :8000)."""

import sys

import httpx

BASE = "http://localhost:8000"


def main() -> int:
    with httpx.Client(base_url=BASE) as c:
        roster = c.get("/api/auth/roster").json()
        kdt = next(u for u in roster if u["display_name"] == "Kommandant")
        viewer = next(u for u in roster if u["role"] == "viewer")
        print(f"roster: {len(roster)} users")

        # correct login
        r = c.post("/api/auth/login", json={"user_id": kdt["id"], "pin": "112112"})
        assert r.status_code == 200, r.text
        assert r.json()["role"] == "editor"
        print("login OK ->", r.json()["display_name"])

        # /me with cookie
        me = c.get("/api/auth/me")
        assert me.status_code == 200 and me.json()["username"] == "kdt", me.text
        print("/me OK")

        # refresh
        rr = c.post("/api/auth/refresh")
        assert rr.status_code == 200, rr.text
        print("refresh OK")

        # logout revokes
        lo = c.post("/api/auth/logout")
        assert lo.status_code == 200
        me2 = c.get("/api/auth/me")
        assert me2.status_code == 401, f"expected 401 after logout, got {me2.status_code}"
        print("logout + revoke OK (/me -> 401)")

    # cooldown: fresh client (no cookies), hammer wrong PIN on the viewer
    with httpx.Client(base_url=BASE) as c:
        saw_429 = False
        for i in range(1, 9):
            r = c.post("/api/auth/login", json={"user_id": viewer["id"], "pin": "999999"})
            tag = r.status_code
            if r.status_code == 429:
                saw_429 = True
            print(f"  wrong-pin attempt {i}: HTTP {tag} :: {r.json().get('detail')}")
        assert saw_429, "expected a 429 cooldown after the free attempts"
        print("cooldown OK (429 after free tier, never permanent)")

    print("\nALL AUTH SMOKE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
