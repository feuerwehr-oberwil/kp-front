#!/usr/bin/env python3
"""Generate the KP-Front app-icon SVGs into the repo, then run tools/icons/build.sh.

Mark: a folded tactical map with a large red location pin (Lage + incident point), with
the "kp front" wordmark above it. One source of truth here; build.sh rasterises to PNGs.
The wordmark uses Avenir Next — fonts are only needed at build time on this machine since
the committed assets are the rasterised PNGs (+ a text-free favicon), so there is no
runtime font dependency.

Run:  python3 tools/icons/gen.py  (writes SVGs)  then  bash tools/icons/build.sh
"""
import os

INK = ('#26344a', '#1b2330', '#141a24')
RED = '#e8392b'
CY = 262  # vertical centre of the content bbox (wordmark top ~81 .. map bottom ~442)

# The map + pin glyph, in 512-space. bbox ~ x100..414, y130..417 (centre ~257,274).
GRAPHIC = '''      <ellipse cx="256" cy="398" rx="150" ry="19" fill="#000" opacity="0.22"/>
      <g stroke="#c4cedb" stroke-width="3" stroke-linejoin="round">
        <polygon points="100,216 198,190 198,380 100,406" fill="#e7edf4"/>
        <polygon points="208,190 306,216 306,406 208,380" fill="#ffffff"/>
        <polygon points="316,216 414,190 414,380 316,406" fill="#d8e1ec"/>
      </g>
      <path fill="{RED}" d="M256 350 C221 297 186 260 186 206 A70 70 0 1 1 326 206 C326 260 291 297 256 350 Z"/>
      <circle cx="256" cy="200" r="30" fill="#fff"/>'''.replace('{RED}', RED)

# Wordmark + map/pin, in 512-space, centred horizontally on x=256.
CONTENT = '''    <text x="256" y="176" font-family="Avenir Next" font-weight="800" font-size="132" text-anchor="middle" fill="#fff">kp</text>
    <text x="256" y="262" font-family="Avenir Next" font-weight="600" font-size="68" letter-spacing="6" text-anchor="middle" fill="{RED}">front</text>
    <g transform="translate(256 366) scale(0.56) translate(-256 -268)">
''' + GRAPHIC + '''
    </g>'''
CONTENT = CONTENT.replace('{RED}', RED)


def svg(bg_rect, fit):
    wrap = f'<g transform="translate(256 256) scale({fit}) translate(-256 -{CY})">'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">\n'
            f'  <defs><radialGradient id="bg" cx="50%" cy="36%" r="80%">\n'
            f'    <stop offset="0%" stop-color="{INK[0]}"/><stop offset="58%" stop-color="{INK[1]}"/>'
            f'<stop offset="100%" stop-color="{INK[2]}"/>\n  </radialGradient></defs>\n'
            f'  {bg_rect}\n  {wrap}\n{CONTENT}\n  </g>\n</svg>\n')


ROUNDED = '<rect width="512" height="512" rx="114" fill="url(#bg)"/>'
FULL = '<rect width="512" height="512" fill="url(#bg)"/>'

# Favicon: the map + pin glyph (no wordmark — text is illegible at 16px), scaled to fill
# a rounded 32px square. Same graphic as the icon, so the favicon reads as the app shrunk.
FAVICON = ('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">\n'
           f'  <rect width="32" height="32" rx="7" fill="{INK[1]}"/>\n'
           '  <g transform="translate(16 16.5) scale(0.085) translate(-257 -274)">\n'
           + GRAPHIC + '\n  </g>\n</svg>\n')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))


def _write(path, content):
    with open(path, 'w') as f:
        f.write(content)
    print('wrote', os.path.relpath(path, ROOT))


_write(os.path.join(HERE, 'appicon-rounded.svg'), svg(ROUNDED, 1.06))   # purpose "any"
_write(os.path.join(HERE, 'appicon-maskable.svg'), svg(FULL, 0.88))     # safe-zone inset
_write(os.path.join(HERE, 'appicon-apple.svg'), svg(FULL, 1.0))         # iOS rounds corners
_write(os.path.join(ROOT, 'public', 'favicon.svg'), FAVICON)
