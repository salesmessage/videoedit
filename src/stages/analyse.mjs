// Reading a take that arrived as a finished mp4.
//
// The pipeline this is modelled on recorded its own footage and so knew where
// the cursor was and when it clicked. A file dropped in a folder carries none
// of that, so everything the later stages need has to be recovered from the
// pixels and the waveform:
//
//   * where the narration is  -- an RMS envelope, thresholded
//   * where the picture is still
//   * where the picture is changing, and how widely
//
// The last one is the interesting substitution. A click leaves no trace in an
// mp4, but the thing a click *does* — a menu opens, a field fills, a row
// highlights — changes pixels in one small place. That is the same signal the
// cursor telemetry was standing in for, and it is recoverable here.
//
// EVERY THRESHOLD IS DERIVED FROM THE TAKE, NOT FIXED.
//
// This matters more than it sounds. These recordings come off different mics
// in different rooms; the one this was built against averages -36 dBFS, so a
// -40 dB silence gate — a perfectly sensible number, and ffmpeg's own default
// neighbourhood — finds no silence in it at all and the tightening stage
// quietly does nothing. A gate placed relative to the take's own noise floor
// works on the quiet one and the loud one both.

import fs from 'node:fs';
import path from 'node:path';
import { stream, probe, detect } from '../lib/ffmpeg.mjs';

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

/** Contiguous runs where `test` holds, as [start, end] in seconds. */
function runsOf(flags, dt, minLen = 0) {
  const runs = [];
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue;
    let j = i;
    while (j < flags.length && flags[j]) j++;
    if ((j - i) * dt >= minLen) runs.push([i * dt, j * dt]);
    i = j - 1;
  }
  return runs;
}

/** Interval intersection of two sorted, non-overlapping run lists. */
export function intersect(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

/**
 * The narration's shape: a 20 ms RMS envelope, and the gate that separates
 * speech from room tone in *this* recording.
 */
export async function audioTrack(file, { hop = 0.02, minSilence = 0.3 } = {}) {
  const sr = 16000;
  const dec = stream([
    '-v', 'error', '-i', file,
    '-map', '0:a:0', '-ac', '1', '-ar', String(sr),
    '-f', 's16le', '-',
  ]);
  dec.stderr.resume();

  const span = Math.round(sr * hop);
  const db = [];
  let acc = 0;
  let n = 0;
  let carry = null;

  for await (const chunk of dec.stdout) {
    let buf = chunk;
    if (carry) { buf = Buffer.concat([carry, chunk]); carry = null; }
    const usable = buf.length - (buf.length % 2);
    if (usable < buf.length) carry = buf.subarray(usable);

    for (let o = 0; o < usable; o += 2) {
      const s = buf.readInt16LE(o) / 32768;
      acc += s * s;
      if (++n < span) continue;
      db.push(10 * Math.log10(acc / n + 1e-12));
      acc = 0;
      n = 0;
    }
  }
  if (n) db.push(10 * Math.log10(acc / n + 1e-12));

  if (!db.length) return null;

  // Smooth over ~100 ms. A gate on the raw envelope chatters on every glottal
  // stop, which turns one sentence into forty "speech runs".
  const k = Math.max(1, Math.round(0.1 / hop));
  const smooth = db.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(db.length - 1, i + k); j++) { s += db[j]; c++; }
    return s / c;
  });

  const sorted = [...smooth].sort((a, b) => a - b);
  const floor = percentile(sorted, 0.1);
  const peak = percentile(sorted, 0.95);
  // Sit the gate above the noise floor but well under the voice. The clamp
  // keeps it sane when a take is all voice (no floor to speak of) or all room
  // tone (no voice to speak of).
  // A third of the way from room tone to voice. Placed lower it starts calling
  // breaths and mouse clicks "speech", which keeps every pause alive; placed
  // higher it clips the quiet ends of sentences.
  const gate = Math.min(peak - 8, Math.max(floor + 8, floor + (peak - floor) * 0.35));

  const loud = smooth.map((v) => v > gate);
  const speech = runsOf(loud, hop, 0.2);
  const silence = runsOf(loud.map((v) => !v), hop, minSilence);

  return { hop, floorDb: floor, peakDb: peak, gateDb: gate, speech, silence };
}

/**
 * Where the picture is changing, sampled on a coarse grid.
 *
 * The video is decoded once at a fraction of its size — one cell of the
 * thumbnail already covers a 10px region of the real frame, finer than any
 * zoom decision needs. Each sample carries how much moved (`energy`), where
 * the centre of that movement was, and how far it was spread out. Spread is
 * what separates a click from a scroll: a menu opening moves a handful of
 * neighbouring cells, a page scroll moves all of them, and zooming into the
 * centroid of a scroll would crop away the thing being scrolled past.
 */
export async function motionTrack(file, { sampleFps, sampleWidth, stillEnergy = 2e-4, blankDetail = 8, blankMin = 0.3 }) {
  const v = probe(file);
  const w = Math.max(48, Math.round(sampleWidth / 2) * 2);
  const h = Math.max(32, Math.round((w * v.height) / v.width / 2) * 2);
  const frameBytes = w * h;

  const dec = stream([
    '-v', 'error',
    '-i', file,
    '-vf', `fps=${sampleFps},scale=${w}:${h}:flags=area,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ]);
  dec.stderr.resume();

  const samples = [];
  const buf = Buffer.allocUnsafe(frameBytes);
  const prev = Buffer.allocUnsafe(frameBytes);
  const xs = new Float64Array(w);
  const ys = new Float64Array(h);

  let havePrev = false;
  let filled = 0;
  let index = 0;

  for await (const chunk of dec.stdout) {
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(frameBytes - filled, chunk.length - off);
      chunk.copy(buf, filled, off, off + n);
      filled += n;
      off += n;
      if (filled < frameBytes) continue;
      filled = 0;

      if (havePrev) {
        xs.fill(0);
        ys.fill(0);
        let total = 0;

        for (let y = 0, i = 0; y < h; y++) {
          let rowSum = 0;
          for (let x = 0; x < w; x++, i++) {
            // A compressed screen recording never sits perfectly still, so a
            // small per-pixel delta is ringing, not motion.
            const d = Math.abs(buf[i] - prev[i]);
            if (d < 12) continue;
            xs[x] += d;
            rowSum += d;
          }
          ys[y] = rowSum;
          total += rowSum;
        }

        // How much detail the frame holds. A page that has not painted yet —
        // a blank white tab, or the dark plum a Salesforce page shows while it
        // loads — is a flat field; a real interface never is. Measured across
        // this take the two do not overlap: blanks sit at a standard deviation
        // of 0.6 and the quietest real screen at 14.8.
        let sum = 0;
        let sumSq = 0;
        for (let i = 0; i < frameBytes; i++) { sum += buf[i]; sumSq += buf[i] * buf[i]; }
        const mean = sum / frameBytes;
        const detail = Math.sqrt(Math.max(0, sumSq / frameBytes - mean * mean));

        const sample = { t: index / sampleFps, energy: total / (w * h * 255), detail };
        if (total > 0) {
          let mx = 0;
          let my = 0;
          for (let x = 0; x < w; x++) mx += (x + 0.5) * xs[x];
          for (let y = 0; y < h; y++) my += (y + 0.5) * ys[y];
          mx /= total;
          my /= total;

          let vx = 0;
          let vy = 0;
          for (let x = 0; x < w; x++) vx += xs[x] * (x + 0.5 - mx) ** 2;
          for (let y = 0; y < h; y++) vy += ys[y] * (y + 0.5 - my) ** 2;

          sample.cx = mx / w;
          sample.cy = my / h;
          // One standard deviation of the moving pixels, as a fraction of the
          // frame, averaged over the two axes.
          sample.spread = (Math.sqrt(vx / total) / w + Math.sqrt(vy / total) / h) / 2;
        }
        samples.push(sample);
      }

      buf.copy(prev);
      havePrev = true;
      index++;
    }
  }

  // The first sample is a difference, so it describes the interval ending at
  // its own timestamp — run times are offset by that, not by zero.
  const dt = 1 / sampleFps;
  const t0 = samples.length ? samples[0].t : 0;
  const shift = (r) => r.map(([a, b]) => [t0 + a, t0 + b]);

  // Two grades of "nothing is happening", and the edit treats them
  // differently. Inside a *frozen* stretch every frame is the same frame, so a
  // splice there is literally invisible and the stretch can simply be shortened.
  // A *calm* stretch still moves a little — a spinner, a blinking caret — so it
  // is played fast instead, which keeps the motion continuous.
  const frozen = shift(runsOf(samples.map((s) => s.energy <= 1e-6), dt, 0.3));
  const calm = shift(runsOf(samples.map((s) => s.energy <= stillEnergy), dt, 0.3));

  // Stretches where the recording shows nothing. The renderer holds the last
  // frame that had something on it rather than putting a blank page on screen.
  const blank = shift(runsOf(samples.map((s) => s.detail < blankDetail), dt, blankMin));

  return { samples, sampleFps, frozen, calm, still: calm, blank, duration: v.duration };
}

/**
 * What the narrator says, and when.
 *
 * ffmpeg in this project's build ships whisper.cpp as a filter, so this needs
 * no separate binary — only a model, which is downloaded once into
 * models/ and then reused.
 *
 * The transcript is not used to caption anything. It is used to find the
 * moments where the narrator is listing things, because that is the one
 * editorial cue in these lessons that is genuinely in the audio and nowhere
 * else: no amount of looking at the pixels tells you that "there's freemium,
 * premium and sandbox" wants to be three bullets on screen.
 */
export function transcribe(file, { model, out, language = 'en', gpu = false }) {
  if (!fs.existsSync(model)) {
    throw new Error(
      `speech model not found at ${model}.\n` +
        'Download it once with:\n' +
        '  curl -L -o "' + model + '" \\n' +
        '    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin\n' +
        'or run with --no-lists to skip transcription.',
    );
  }

  // The filtergraph parser treats ":" as an option separator, so a Windows
  // drive letter in either path makes the whole chain unparseable. Both are
  // passed relative to the working directory, which has no colon in it.
  const rel = (p) => path.relative(process.cwd(), p).split(path.sep).join('/');

  // Transcribing a five-minute lesson costs about a minute, and the answer
  // does not change between runs of the same take — which is exactly the
  // situation while someone is iterating on the title copy.
  const cached = fs.existsSync(out) &&
    fs.statSync(out).mtimeMs > fs.statSync(file).mtimeMs;
  if (cached) return parse(out);

  detect([
    '-hide_banner', '-nostats', '-v', 'error',
    '-i', file,
    '-map', '0:a:0',
    '-af',
    `aresample=16000,whisper=model=${rel(model)}:language=${language}` +
      `:format=json:destination=${rel(out)}:queue=20:use_gpu=${gpu ? 'true' : 'false'}`,
    '-f', 'null', '-',
  ]);

  return fs.existsSync(out) ? parse(out) : [];
}

// The filter writes one JSON object per line rather than one document — and it
// does not escape what it puts in `text`, so a narrator who quotes someone
// produces a line JSON.parse refuses. That is not a reason to lose the whole
// transcript, so a failed parse falls back to reading the three fields out
// directly.
function parse(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;

    let o = null;
    try {
      o = JSON.parse(line);
    } catch {
      const m = /"start"\s*:\s*(-?\d+)[\s\S]*?"end"\s*:\s*(-?\d+)[\s\S]*?"text"\s*:\s*"([\s\S]*)"\s*\}\s*$/
        .exec(line);
      if (!m) continue;
      o = { start: Number(m[1]), end: Number(m[2]), text: m[3] };
    }

    const text = String(o.text ?? '').replace(/\\"/g, '"').trim();
    if (!text) continue;
    out.push({ start: o.start / 1000, end: o.end / 1000, text });
  }
  return out;
}
