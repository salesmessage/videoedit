// Black bars baked into the recording.
//
// A take is not always a clean capture of a screen. Depending on how it was
// recorded and exported it can arrive as a smaller picture centred in a 1080p
// frame, with the remainder filled in black — [T1] 1.2 is 1920x930 of dashboard
// sitting inside 1920x1080, 74px of black above and 76 below.
//
// Nothing downstream can recover from that on its own. The matting fits the
// frame it is given, so the bars go into the card and about a seventh of it is
// dead black inside the pale ring; the zoom's motion salience sees a large
// region that never changes and biases away from it; blank detection measures
// the standard deviation of a frame that is part black and reads lower than the
// screen deserves. All three are the same mistake — treating the delivery frame
// as the picture — so the fix belongs here, before any of them look at it.
//
// This runs before everything else and hands the rest of the pipeline an
// ordinary take, which is why it re-encodes rather than threading a crop
// through each stage's decode: a crop that one stage forgets is a bug nobody
// sees until the framing is subtly wrong in an already-rendered lesson.

import fs from 'node:fs';
import path from 'node:path';
import { run, detect, probe } from '../lib/ffmpeg.mjs';

/**
 * What ffmpeg's cropdetect makes of the picture, sampled across the take.
 *
 * One frame is not enough to trust: a screen recording can open on a dark
 * splash, and a lesson that happens to show a black-backgrounded panel would
 * have its own content cropped away. So several frames spread through the take
 * are measured and only the *smallest* crop any of them justifies is kept —
 * bars that are not black in every sample are not bars.
 */
export function detectBars(file, { duration, samples = 9, limit = 24 } = {}) {
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  let seen = 0;

  for (let i = 1; i <= samples; i++) {
    const at = (duration * i) / (samples + 1);
    const log = detect([
      '-hide_banner', '-ss', at.toFixed(2), '-i', file, '-frames:v', '4',
      '-vf', `cropdetect=limit=${limit}:round=2:reset=0`, '-f', 'null', '-',
    ]);
    // The last line cropdetect prints for a frame is its running conclusion.
    const hits = [...log.matchAll(/x1:(\d+)\s+x2:(\d+)\s+y1:(\d+)\s+y2:(\d+)/g)];
    const m = hits[hits.length - 1];
    if (!m) continue;
    const [, x1, x2, y1, y2] = m.map(Number);
    // A frame that is entirely black tells us nothing about where the picture is.
    if (x2 <= x1 || y2 <= y1) continue;
    box.x1 = Math.min(box.x1, x1);
    box.y1 = Math.min(box.y1, y1);
    box.x2 = Math.max(box.x2, x2);
    box.y2 = Math.max(box.y2, y2);
    seen++;
  }

  if (!seen) return null;
  return { x: box.x1, y: box.y1, w: box.x2 - box.x1 + 1, h: box.y2 - box.y1 + 1 };
}

/**
 * Trim the bars off, if there are any worth trimming.
 *
 * Returns the file the rest of the pipeline should use — the original when
 * there is nothing to do, so a clean take costs one probe and no encode.
 */
export function trimLetterbox({ input, work, source, config, onNote }) {
  const opt = config.frame.letterbox;
  if (!opt || opt.trim === false) return { file: input, source, crop: null };

  const crop = opt.crop ?? detectBars(input, {
    duration: source.duration,
    limit: opt.limit,
    samples: opt.samples,
  });
  if (!crop) return { file: input, source, crop: null };

  const dropped = (source.width - crop.w) + (source.height - crop.h);
  // Encoders round dimensions and cropdetect rounds to even numbers, so a
  // couple of pixels either way is noise, not a letterbox. Re-encoding the
  // whole take to shave two pixels off is not worth the generation loss.
  if (dropped < opt.min) return { file: input, source, crop: null };

  // An odd width or height is not encodable in yuv420p. Give the extra pixel
  // back to the picture rather than taking one more away from it.
  const w = crop.w + (crop.w % 2);
  const h = crop.h + (crop.h % 2);
  const x = Math.max(0, Math.min(crop.x, source.width - w));
  const y = Math.max(0, Math.min(crop.y, source.height - h));

  const file = path.join(work, 'cropped.mkv');
  fs.rmSync(file, { force: true });
  run([
    '-y', '-v', 'error', '-i', input,
    '-vf', `crop=${w}:${h}:${x}:${y}`,
    '-c:v', 'libx264', '-crf', String(opt.crf), '-preset', opt.preset,
    '-pix_fmt', 'yuv420p',
    ...(source.hasAudio ? ['-c:a', 'copy'] : ['-an']),
    file,
  ], { label: 'letterbox crop' });

  if (onNote) {
    onNote(
      `${source.width}x${source.height} -> ${w}x${h} ` +
      `(trimmed ${source.height - h}px vertical, ${source.width - w}px horizontal)`,
    );
  }
  return { file, source: probe(file), crop: { x, y, w, h } };
}
