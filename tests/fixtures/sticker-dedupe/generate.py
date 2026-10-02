# Regenerate with python3 tests/fixtures/sticker-dedupe/generate.py (Pillow).
# Synthetic assets only. Samples provide a deterministic unit-test decoder;
# desktop tests exercise the actual Chromium decoder using these same WebPs.
from PIL import Image, ImageDraw
from io import BytesIO
from pathlib import Path
import base64, json

image = Image.new('RGBA', (72, 64), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
# Strong alternating gradients make dHash resistant to encoding noise.
for y in range(64):
    for x in range(72):
        v = 60 + int((x if (y // 16) % 2 == 0 else 71 - x) * 1.9)
        draw.point((x, y), (v, int(v * .6), int(v * .4), 255))
draw.ellipse((20, 15, 50, 48), fill=(30, 170, 210, 255))
other = image.copy()
ImageDraw.Draw(other).rectangle((10, 10, 60, 53), fill=(30, 170, 210, 255))
frames = []
second = image.copy()
ImageDraw.Draw(second).rectangle((0, 0, 10, 10), fill='white')
fixtures = {}
for name, picture, quality, animated in [('original', image, 90, False), ('reencoded', image, 75, False), ('different', other, 90, False), ('animated', image, 90, True)]:
    output = BytesIO()
    if animated:
        picture.save(output, format='WEBP', quality=quality, save_all=True, append_images=[second], duration=100, loop=0)
    else:
        picture.save(output, format='WEBP', quality=quality)
    data = output.getvalue()
    first = Image.open(BytesIO(data)).convert('RGBA')
    white = Image.new('RGBA', first.size, 'white')
    white.alpha_composite(first)
    samples = white.convert('RGB').resize((9, 8), Image.Resampling.LANCZOS).tobytes()
    fixtures[name] = {'image': 'data:image/webp;base64,' + base64.b64encode(data).decode(), 'pixels': base64.b64encode(samples).decode()}
Path(__file__).with_name('images.json').write_text(json.dumps(fixtures, indent=2) + '\n')
