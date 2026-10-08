#!/usr/bin/env python3
"""Generate the KP-Front app-icon SVGs into the repo, then run tools/icons/build.sh.

Mark: a folded tactical map with a large red location pin (Lage + incident point). The
mark alone, no wordmark: the OS prints the app name under the icon, and the in-app name is
real text next to [[Brand]]. Pairs with KP Rück's magnet-board mark (same tile, same
illustration language). One source of truth here; build.sh rasterises to PNGs.

Two cuts of the same glyph:
  GRAPHIC — shadow + hairline edges, for app icons (≥ 48 px).
  SMALL   — no shadow or hairlines, chunkier pin, darker side panels: the favicon, which is
            also the default login/empty-state logo ([[deploymentLogo]]) at 44 px.

Run:  python3 tools/icons/gen.py  (writes SVGs)  then  bash tools/icons/build.sh
"""
import os

INK = ('#26344a', '#1b2330', '#141a24')
RED = '#e8392b'

# The map + pin glyph, in 512-space. bbox ~ x100..414, y130..417 (centre ~257,274).
GRAPHIC = '''      <ellipse cx="256" cy="398" rx="150" ry="19" fill="#000" opacity="0.22"/>
      <g stroke="#c4cedb" stroke-width="3" stroke-linejoin="round">
        <polygon points="100,216 198,190 198,380 100,406" fill="#e7edf4"/>
        <polygon points="208,190 306,216 306,406 208,380" fill="#ffffff"/>
        <polygon points="316,216 414,190 414,380 316,406" fill="#d8e1ec"/>
      </g>
      <path fill="{RED}" d="M256 350 C221 297 186 260 186 206 A70 70 0 1 1 326 206 C326 260 291 297 256 350 Z"/>
      <circle cx="256" cy="200" r="30" fill="#fff"/>'''.replace('{RED}', RED)

# Small-size cut, already placed in 512-space (fills the tile like GRAPHIC at fit 1.08).
SMALL = '''  <g transform="translate(256 262) scale(1.12) translate(-257 -290)">
    <polygon points="96,222 198,196 198,392 96,418" fill="#b9c4d2"/>
    <polygon points="208,196 306,222 306,418 208,392" fill="#ffffff"/>
    <polygon points="316,222 418,196 418,392 316,418" fill="#b9c4d2"/>
    <path fill="{RED}" d="M257 372 C214 308 172 266 172 204 A85 85 0 1 1 342 204 C342 266 300 308 257 372 Z"/>
    <circle cx="257" cy="200" r="34" fill="#fff"/>
  </g>'''.replace('{RED}', RED)

DEFS = ('  <defs><radialGradient id="bg" cx="50%" cy="36%" r="80%">\n'
        f'    <stop offset="0%" stop-color="{INK[0]}"/><stop offset="58%" stop-color="{INK[1]}"/>'
        f'<stop offset="100%" stop-color="{INK[2]}"/>\n  </radialGradient></defs>\n')

ROUNDED = ('<rect width="512" height="512" rx="114" fill="url(#bg)"/>\n'
           '  <rect x="3" y="3" width="506" height="506" rx="111" fill="none" stroke="#fff" '
           'stroke-opacity=".09" stroke-width="6"/>')
FULL = '<rect width="512" height="512" fill="url(#bg)"/>'


def svg(bg_rect, fit):
    wrap = f'<g transform="translate(256 262) scale({fit}) translate(-257 -274)">'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">\n'
            f'{DEFS}  {bg_rect}\n  {wrap}\n{GRAPHIC}\n  </g>\n</svg>\n')


# Favicon + default logo: the small cut on the rounded tile.
FAVICON = ('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 512 512">\n'
           f'{DEFS}  {ROUNDED}\n{SMALL}\n</svg>\n')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))


def _write(path, content):
    with open(path, 'w') as f:
        f.write(content)
    print('wrote', os.path.relpath(path, ROOT))


_write(os.path.join(HERE, 'appicon-rounded.svg'), svg(ROUNDED, 1.08))   # purpose "any"
_write(os.path.join(HERE, 'appicon-maskable.svg'), svg(FULL, 0.9))      # glyph inside the 40 % safe circle
_write(os.path.join(HERE, 'appicon-apple.svg'), svg(FULL, 1.08))        # iOS rounds corners
_write(os.path.join(ROOT, 'public', 'favicon.svg'), FAVICON)
