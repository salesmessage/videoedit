// The field everything sits on.
//
// A soft, slowly drifting mesh of the brand blue, tinted almost to white. It
// is a pure function of time, which is the whole point: the opening, the title
// card and the mat behind the recording all call it, so the background is
// continuous across every join without anyone having to line the joins up.
//
// Painting it costs real time at full size, which over a five-minute video
// adds up to a minute of wall clock spent on something that changes
// imperceptibly between frames. So it is rendered small and scaled up — the
// blooms are soft enough that nothing survives the difference.

import { createCanvas } from '@napi-rs/canvas';
import { tint, rgba } from './brand.mjs';

const SMALL = 240; // width of the buffer the field is actually painted at

export function createBackground({ width, height, blue, options, refreshEvery = 6 }) {
  const w = SMALL;
  const h = Math.round((SMALL * height) / width);

  const buf = createCanvas(w, h);
  const ctx = buf.getContext('2d');

  // The upscale to full size is the expensive part, and the field moves by
  // less than a pixel between frames — so it is done a few times a second into
  // a full-size cache, and every frame in between is a straight blit.
  const full = createCanvas(width, height);
  const fctx = full.getContext('2d');
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = 'medium';

  const base = tint(blue, options.base);
  const blobs = options.blobs.map((b) => ({ ...b, colour: tint(blue, b.tint) }));

  let cachedFrame = -1;

  return function paint(dst, t, frame = Math.round(t * 30)) {
    if (cachedFrame < 0 || frame - cachedFrame >= refreshEvery) {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);

      for (const b of blobs) {
        const a = 2 * Math.PI * b.hz * t + b.phase;
        const cx = (b.cx + b.ax * Math.sin(a)) * w;
        const cy = (b.cy + b.ay * Math.cos(a * 0.83 + 0.4)) * h;
        const r = b.r * w;

        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, rgba(b.colour, 1));
        g.addColorStop(0.55, rgba(b.colour, 0.45));
        g.addColorStop(1, rgba(b.colour, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }

      fctx.drawImage(buf, 0, 0, width, height);
      cachedFrame = frame;
    }

    dst.drawImage(full, 0, 0);
  };
}
