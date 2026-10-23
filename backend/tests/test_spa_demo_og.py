"""The public demo's Open Graph tags (app/spa.py · with_demo_og) — meta only, before </head>."""

from app.spa import with_demo_og

INDEX = "<html><head><title>KP Front</title><script>var a = 1\n</script></head><body></body></html>"


def test_tags_land_before_head_close_and_scripts_stay_byte_identical():
    out = with_demo_og(INDEX, "https://demo.kp-front.ch/")
    assert out.index('property="og:title"') < out.index("</head>")
    assert '<meta property="og:url" content="https://demo.kp-front.ch/">' in out
    assert "<script>var a = 1\n</script>" in out  # the CSP hash source is untouched


def test_without_public_url_no_og_url_and_without_head_nothing_changes():
    assert "og:url" not in with_demo_og(INDEX)
    assert with_demo_og("<html>no head</html>") == "<html>no head</html>"
