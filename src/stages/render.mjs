// One frame loop for the whole video.
//
// The opening, the title card, the recording and the closing lockup are not
// four clips joined afterwards — they are four things drawn onto one canvas
// over one continuous timeline. That was a deliberate choice, and it buys
// three things that concatenation does not:
//
//   * the drifting background is a function of absolute time, so it runs
//     unbroken through every join instead of restarting at each cut;
//   * the recording can slide in over the title card, because both are being
//     drawn at once during the overlap, rather than dissolved between;
//   * the picture is encoded once. Every extra concat pass is another
//     generation of h264 over the whole runtime.
//
// The body frames arrive as a raw stream from ffmpeg and are consumed in
// order: once the timeline reaches the body, every output frame takes exactly
// one input frame, so no seeking or indexing is needed.

import { createCanvas, ImageData } from '@napi-rs/canvas';
import { once } from 'node:events';
import { stream } from '../lib/ffmpeg.mjs';
import { createBackground } from '../lib/background.mjs';
import {
  drawOpening, drawTitle, drawClosing, drawList,
  layoutTitle, layoutList, easeOutCubic, easeInOutCubic,
} from '../lib/cards.mjs';
import { rgba } from '../lib/brand.mjs';

/** Where each act starts and ends, in output seconds. */
export function buildTimeline({ config, bodyDuration }) {
  const i = config.intro;
  const t = config.title;

  const introDur = i.hold + i.markIn + i.markSettle + i.build + i.rest;
  const titleIn = t.pillGrow + t.wordIn + t.wordStagger * 8;
  const titleDur = Math.max(titleIn + t.hold, 2.2);

  const openEnd = introDur + i.out + titleDur;
  const bodyStart = openEnd - config.frame.slideIn;
  const bodyEnd = bodyStart + bodyDuration;
  const outroStart = bodyEnd - config.outro.in;
  const total = outroStart + config.outro.in + config.outro.hold + config.outro.out;

  return {
    introDur,
    introFadeOut: i.out,
    titleStart: introDur,
    titleEnd: openEnd,
    bodyStart,
    bodyEnd,
    outroStart,
    total,
  };
}

export async function render({
  bodyFile,
  output,
  config,
  brand,
  art,
  fonts,
  zoomAt,
  bodyDuration,
  onProgress,
}) {
  const W = config.width;
  const H = config.height;
  const FPS = config.fps;

  const tl = buildTimeline({ config, bodyDuration });
  const totalFrames = Math.round(tl.total * FPS);
  const bodyFrames = Math.round(bodyDuration * FPS);

  // ---- canvases ----
  const dst = createCanvas(W, H);
  const ctx = dst.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  // 'medium' rather than 'high'. The recording is scaled by well under 2x in
  // either direction, where the two are indistinguishable side by side on real
  // screen content — and 'high' costs about 50 ms a frame, which is half an
  // hour over a five-minute lesson.
  ctx.imageSmoothingQuality = config.encode.scaleQuality;

  const paintBackground = createBackground({
    width: W, height: H, blue: brand.blue, options: config.background,
  });

  // The body frame lands in its own canvas so it can be drawn through a
  // transform. Its backing store is reused: allocating a fresh 8 MB frame per
  // tick costs more in collection than all the drawing put together.
  const srcW = config.source.width;
  const srcH = config.source.height;
  const src = createCanvas(srcW, srcH);
  const sctx = src.getContext('2d');
  const srcImage = new ImageData(srcW, srcH);
  const srcView = Buffer.from(
    srcImage.data.buffer, srcImage.data.byteOffset, srcImage.data.byteLength,
  );

  // ---- where the recording sits ----
  // The card is the recording plus a ring: the examples inset the screenshot
  // about 12px inside the rounded rectangle, so the recording is fitted to the
  // inside and the card is that plus the ring on every side.
  const border = config.frame.border;
  const availW = W - config.frame.paddingX * 2 - border * 2;
  const availH = H - config.frame.minPaddingY * 2 - border * 2;
  const fit = Math.min(availW / srcW, availH / srcH);
  const innerW = Math.round(srcW * fit);
  const innerH = Math.round(srcH * fit);
  const ww = innerW + border * 2;
  const wh = innerH + border * 2;
  const wx = Math.round((W - ww) / 2);
  const wy = Math.round((H - wh) / 2);


  // ---- title copy ----
  const titleStyle = {
    ...config.title,
    headFont: fonts.headline,
    bodyFont: fonts.body,
  };
  const introStyle = {
    ...config.intro,
    wordFont: fonts.body,
    word: config.copy.introWord ?? '',
  };
  const layout = layoutTitle(ctx, {
    headline: config.copy.headline,
    highlight: config.copy.highlight,
    style: titleStyle,
    width: W,
  });

  // ---- list sections ----
  // Times arrive on the body's own clock and are shifted onto the output
  // timeline here, once, so nothing downstream has to remember the offset.
  // Each section is laid out up front for the same reason the title card is:
  // the reveal has to animate over type that does not move under it.
  const listStyle = { ...config.list, headFont: fonts.headline, bodyFont: fonts.body };
  const sections = (config.sections ?? []).map((sec) => {
    const start = tl.bodyStart + sec.start;
    const end = tl.bodyStart + sec.end;
    // Fit the points inside the section rather than letting a slow stagger run
    // past the end of it, which would leave the last one flashing on and off.
    const room = (end - start) * 0.6 - config.list.itemsStart;
    const stagger = Math.min(
      config.list.itemStagger,
      Math.max(0.4, room / Math.max(1, sec.items.length - 1)),
    );
    return {
      start, end,
      // Which part of the recording survives the crop. The examples anchor
      // left, but that is a fact about what was on the left in those lessons,
      // not a rule: anchoring left here would keep a settings sidebar and cut
      // away the panel the narrator is talking about. So it follows the motion
      // when there is any, and falls back to the example's behaviour when the
      // screen was still for the whole section.
      focusX: sec.focusX ?? 0,
      style: { ...listStyle, itemStagger: stagger },
      layout: layoutList(ctx, {
        headline: sec.headline,
        highlight: sec.highlight,
        items: sec.items,
        style: listStyle,
        width: W,
      }),
    };
  });

  // Whether the frame in hand shows anything.
  //
  // Measured here, on the frame itself, rather than from spans worked out
  // during analysis and mapped onto this timeline. The mapped version was
  // right about *where* the blanks were and still showed them: the spans were
  // inset slightly at each end to avoid freezing over real content, which let
  // the first two genuinely blank frames through — and the hold then faithfully
  // held one of those. A per-frame test cannot have an off-by-a-frame.
  //
  // Every sixteenth pixel in each direction is plenty: a blank page is flat
  // everywhere, and 8000 samples put the measurement within a rounding error of
  // the full-frame figure for a fraction of the cost.
  const SUB = 16;
  function detailOf(buf) {
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = 0; y < srcH; y += SUB) {
      const row = y * srcW * 4;
      for (let x = 0; x < srcW; x += SUB) {
        const v = buf[row + x * 4 + 1]; // green stands in for luma
        sum += v;
        sumSq += v * v;
        n++;
      }
    }
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  }

  let heldFrames = 0;

  /** How far into the list layout the picture should be at time t: 0..1. */
  function listBlend(t) {
    let best = { k: 0, section: null };
    for (const sec of sections) {
      if (t < sec.start - config.list.move || t > sec.end + config.list.out) continue;
      const inK = easeInOutCubic((t - (sec.start - config.list.move)) / config.list.move);
      const outK = 1 - easeInOutCubic((t - sec.end) / config.list.out);
      const k = Math.min(inK, Math.max(0, outK));
      if (k > best.k) best = { k, section: sec };
    }
    return best;
  }

  // ---- ffmpeg ----
  const dec = stream([
    '-v', 'error',
    '-i', bodyFile,
    '-map', '0:v:0',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ]);
  dec.stderr.resume();

  const enc = stream([
    '-y', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS),
    '-i', '-',
    '-an',
    '-c:v', 'libx264',
    '-preset', config.encode.preset,
    '-crf', String(config.encode.crf),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ]);
  let encErr = '';
  enc.stderr.on('data', (d) => (encErr += d));
  enc.stdout.resume();

  // napi-rs hands back the canvas's own pixels, and Node's stream keeps a
  // reference to whatever is written until it is actually flushed — so writing
  // that buffer directly means the next frame is drawn into a frame that has
  // not gone out yet. Two buffers, each reused only once its own write has
  // completed, keeps one frame in flight without the copy racing the drawing.
  const readPixels = typeof dst.data === 'function'
    ? () => dst.data()
    : () => Buffer.from(ctx.getImageData(0, 0, W, H).data.buffer);

  const outBytes = W * H * 4;
  const pool = [Buffer.allocUnsafe(outBytes), Buffer.allocUnsafe(outBytes)];
  const flushed = [Promise.resolve(), Promise.resolve()];
  let slot = 0;

  const write = async () => {
    await flushed[slot];
    readPixels().copy(pool[slot]);
    const mine = slot;
    flushed[mine] = new Promise((resolve, reject) => {
      enc.stdin.write(pool[mine], (err) => (err ? reject(err) : resolve()));
    });
    slot ^= 1;
  };

  // The plate is redrawn whenever the window rect changes, which during a list
  // move is every frame. Rebuilding a 70px-blur shadow per frame costs ~80ms,
  // so the moving version is drawn into a scratch canvas at a coarser blur and
  // the settled ones — base and list, the two rects it rests at — are cached.
  const plateCache = new Map();
  const scratch = createCanvas(W, H);

  function plateFor(rect, moving) {
    const key = `${Math.round(rect.x)},${Math.round(rect.w)}`;
    if (!moving && plateCache.has(key)) return plateCache.get(key);

    const target = moving ? scratch : createCanvas(W, H);
    const p = target.getContext('2d');
    p.clearRect(0, 0, W, H);
    p.shadowColor = rgba(config.frame.shadowColor, config.frame.shadowAlpha);
    p.shadowBlur = moving ? config.frame.shadowBlur * 0.6 : config.frame.shadowBlur;
    p.shadowOffsetY = config.frame.shadowOffsetY;
    // The plate is not white and it is not only a shadow catcher: the examples
    // inset the recording ~12px inside the rounded card, and that inset shows
    // as a pale ring all the way round. Without it the screenshot runs to the
    // rounded edge and the card reads as flat.
    p.fillStyle = config.frame.borderColor;
    p.beginPath();
    p.roundRect(rect.x, rect.y, rect.w, rect.h, config.frame.radius);
    p.fill();

    if (!moving) plateCache.set(key, target);
    return target;
  }

  // ---- the recording's own frame ----
  function drawBody(t, bodyT) {
    // Slide in from the right over the title card, and settle out of a slight
    // over-scale. Both are done here rather than as a transition between two
    // clips so the background behind never moves.
    const inK = easeInOutCubic((t - tl.bodyStart) / config.frame.slideIn);
    const settleK = easeOutCubic((t - tl.bodyStart) / config.frame.settle);
    const outK = 1 - easeInOutCubic((t - tl.outroStart) / config.outro.in);

    const alpha = Math.min(1, Math.max(0, outK));
    if (alpha <= 0) return;

    const slide = (1 - inK) * (W - wx) * 1.05;
    const zoomIn = config.frame.settleScale - (config.frame.settleScale - 1) * settleK;
    const { z, cx, cy } = zoomAt(bodyT);

    // A list section narrows the window without changing the magnification —
    // the recording is cropped, not shrunk, which is what keeps the interface
    // readable at a third of the width. Zoom eases out as the move happens,
    // and the focus travels to the source's left edge, which the same clamp
    // that stops a zoom revealing the mat resolves for free.
    const { k: listK, section: listSec } = listBlend(t);
    const lw = config.list.window;
    const mix = (a, b) => a + (b - a) * listK;
    const rect = {
      x: mix(wx, lw.x), y: mix(wy, lw.y), w: mix(ww, lw.w), h: mix(wh, lw.h),
    };

    const inner = { w: rect.w - border * 2, h: rect.h - border * 2 };
    const scale = (innerW / srcW) * mix(z, 1) * mix(zoomIn, 1);
    const halfW = inner.w / 2 / scale;
    const halfH = inner.h / 2 / scale;
    const fx = Math.min(Math.max(mix(cx, listSec?.focusX ?? 0) * srcW, halfW), srcW - halfW);
    const fy = Math.min(Math.max(mix(cy, 0.5) * srcH, halfH), srcH - halfH);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(slide, 0);

    ctx.drawImage(plateFor(rect, listK > 0.001 && listK < 0.999), 0, 0);

    // The recording is clipped to the inside of that ring, on a radius that
    // keeps the two curves concentric.
    ctx.beginPath();
    ctx.roundRect(
      rect.x + border, rect.y + border, inner.w, inner.h,
      Math.max(0, config.frame.radius - border),
    );
    ctx.clip();
    ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-fx, -fy);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }

  // ---- run ----
  const frameBytes = srcW * srcH * 4;
  const frameBuf = Buffer.allocUnsafe(frameBytes);
  let filled = 0;
  let bodyIndex = 0; // body frames consumed
  let out = 0; // output frames written
  let havePixels = false;

  async function emitUpTo(limit) {
    while (out < limit) {
      const t = out / FPS;
      paintBackground(ctx, t, out);

      if (t < tl.titleEnd) {
        const introAlpha =
          t < tl.introDur ? 1 : 1 - easeInOutCubic((t - tl.introDur) / tl.introFadeOut);
        if (introAlpha > 0.001) {
          drawOpening(ctx, t, { art, style: introStyle, width: W, height: H, alpha: introAlpha });
        }
        // The card starts building while the lockup is still dissolving, which
        // is what stops the middle of the opening from going empty.
        if (t >= tl.titleStart) {
          drawTitle(ctx, t - tl.titleStart, {
            layout, badge: config.copy.badge, style: titleStyle, brand,
            width: W, height: H,
          });
        }
      }

      if (t >= tl.bodyStart && t < tl.bodyEnd && havePixels) {
        drawBody(t, (out - Math.round(tl.bodyStart * FPS)) / FPS);

        // The copy goes on after the recording, not before: it lives on the
        // mat to the left, and the window has already been drawn opaquely.
        const { k, section } = listBlend(t);
        if (section && k > 0.001) {
          drawList(ctx, t - section.start, {
            layout: section.layout, art, style: section.style, brand,
            width: W, alpha: k,
          });
        }
      }

      if (t >= tl.outroStart) {
        const k = easeInOutCubic((t - tl.outroStart) / config.outro.in);
        const fadeOut = 1 - easeInOutCubic((t - (tl.total - config.outro.out)) / config.outro.out);
        drawClosing(ctx, {
          art, style: introStyle, width: W, height: H,
          alpha: Math.min(k, Math.max(0, fadeOut)),
          scale: config.outro.lockupScale * (0.97 + 0.03 * k),
        });
      }

      await write();
      out++;
      if (onProgress && out % 90 === 0) onProgress(out, totalFrames);
    }
  }

  // Everything before the body needs no input frames.
  await emitUpTo(Math.round(tl.bodyStart * FPS));

  outer:
  for await (const chunk of dec.stdout) {
    let off = 0;
    while (off < chunk.length) {
      // The timeline is the authority on length. A body that decodes longer
      // than it measured (rounding, a rebuilt index) would otherwise keep
      // costing a full frame upload each for pixels nobody will see.
      if (out >= totalFrames) { dec.kill(); break outer; }
      const n = Math.min(frameBytes - filled, chunk.length - off);
      chunk.copy(frameBuf, filled, off, off + n);
      filled += n;
      off += n;
      if (filled < frameBytes) continue;
      filled = 0;

      // A frame with nothing on it is not shown. The last frame that had
      // something stays on screen instead, which reads as the recording
      // pausing rather than as the video breaking. The decoded frame is still
      // consumed, so the body stays in step with its own audio.
      if (havePixels && config.frame.holdBlanks
          && detailOf(frameBuf) < config.frame.blankDetail) {
        heldFrames++;
      } else {
        frameBuf.copy(srcView);
        sctx.putImageData(srcImage, 0, 0);
        havePixels = true;
      }
      bodyIndex++;

      await emitUpTo(Math.min(totalFrames, Math.round(tl.bodyStart * FPS) + bodyIndex));
    }
  }

  // The tail: the last body frame stays on screen under the closing dissolve.
  await emitUpTo(totalFrames);

  await Promise.all(flushed);
  enc.stdin.end();
  const [code] = await once(enc, 'close');
  if (code !== 0) throw new Error(`encode failed (${code})\n${encErr.slice(-2000)}`);

  return {
    frames: out,
    heldFrames,
    bodyFrames: bodyIndex,
    expectedBodyFrames: bodyFrames,
    duration: out / FPS,
    timeline: tl,
    window: { x: wx, y: wy, w: ww, h: wh },
  };
}
