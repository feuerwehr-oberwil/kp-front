# Generates the EXIF fixtures for src/lib/exif.test.ts (run with: uv run --with pillow --with pillow-heif python gen.py OUT)
import sys, os
from fractions import Fraction
from PIL import Image, ExifTags
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
R = lambda x: Fraction(x).limit_denominator(1000000)

def img(color):
    return Image.new('RGB', (16, 12), color)

def gps_exif(lat, lng, alt=None, heading=None, ref='T', taken='2026:10:08 14:32:05', offset='+02:00', orientation=None):
    ex = Image.Exif()
    if orientation: ex[0x0112] = orientation
    ex[0x010F] = 'Apple'; ex[0x0110] = 'iPhone 15'   # Make/Model: must NOT survive into the record
    ifd = ex.get_ifd(0x8769)
    if taken: ifd[0x9003] = taken
    if offset: ifd[0x9011] = offset
    if lat is not None:
        g = ex.get_ifd(0x8825)
        def dms(v):
            v = abs(v); d = int(v); m = int((v - d) * 60); s = (v - d - m / 60) * 3600
            return (R(d), R(m), R(round(s, 4)))
        g[1] = 'N' if lat >= 0 else 'S'; g[2] = dms(lat)
        g[3] = 'E' if lng >= 0 else 'W'; g[4] = dms(lng)
        if alt is not None: g[5] = b'\x00' if alt >= 0 else b'\x01'; g[6] = R(abs(alt))
        if heading is not None: g[0x10] = ref; g[0x11] = R(heading)
    return ex

# Oberwil BL, Hauptstrasse-ish
img((200, 40, 40)).save(f'{out}/gps-heading.jpg', exif=gps_exif(47.513889, 7.556944, alt=297.5, heading=228.4, orientation=6), quality=60)
img((40, 200, 40)).save(f'{out}/gps-only.jpg', exif=gps_exif(47.5139, 7.5569, taken='2026:10:08 09:01:00', offset=None), quality=60)
img((40, 40, 200)).save(f'{out}/no-gps.jpg', exif=gps_exif(None, None), quality=60)
img((120, 120, 120)).save(f'{out}/no-exif.jpg', quality=60)
# southern / western hemisphere, magnetic heading
img((10, 10, 10)).save(f'{out}/gps-sw-magnetic.jpg', exif=gps_exif(-33.8568, -151.2153, alt=-12, heading=12.5, ref='M'), quality=60)
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    img((200, 160, 40)).save(f'{out}/gps-heading.heic', exif=gps_exif(47.513889, 7.556944, heading=90).tobytes(), quality=30)
except Exception as e:
    print('heic skipped', e)
for f in sorted(os.listdir(out)): print(f, os.path.getsize(f'{out}/{f}'))

# metadata-stripping fixtures (lib/stripMetadata): a PNG with text + eXIf chunks, a WebP with EXIF
from PIL import PngImagePlugin
info = PngImagePlugin.PngInfo(); info.add_text('Author', 'Max Muster'); info.add_text('Comment', 'Wohnzimmer')
img((10, 120, 200)).save(f'{out}/meta.png', pnginfo=info, exif=gps_exif(47.5139, 7.5569, orientation=None))
img((200, 120, 10)).save(f'{out}/meta.webp', exif=gps_exif(47.5139, 7.5569, orientation=None), quality=60)
img((90, 90, 90)).save(f'{out}/plain.png')
for f in ['meta.png', 'meta.webp', 'plain.png']: print(f, os.path.getsize(f'{out}/{f}'))
