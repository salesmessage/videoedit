#!/usr/bin/env node
// Recover the music bed from a finished lesson, using the fact that it loops.
//
//   node tools/extract-bed.mjs "reference/….Output.mp4" brand/music/academy-bed.wav
//
// The bed under these lessons is a short loop repeated for the whole body — in
// "[T1] 4.2" it is 512000 samples at 48 kHz, exactly 10.666667 s, and it
// repeats fourteen times. That periodicity is what makes a clean extraction
// possible, and it beats any amount of cutting and splicing:
//
//   * the bed is IDENTICAL in every repeat, and the narration is not;
//   * so at any point in the loop there are fourteen observations of the same
//     bed, each with different speech on top;
//   * speech only ever ADDS energy, so per frequency bin the smallest
//     magnitude across the fourteen is the bed, and any repeat where the
//     narrator happened to pause gives it exactly;
//   * and one whole period loops seamlessly by construction — no crossfade,
//     no stitching, no chord changing in a place the composer did not put it.
//
// An earlier version of this tool cut the few pad-only gaps out of the lesson
// and glued them together. That produced 7.7 s of material from 9 fragments,
// needed a 4x time-stretch to be usable, and carried a seam. This needs none of
// that: it reconstructs the actual loop.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FFMPEG } from '../src/lib/ffmpeg.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  argv.splice(i, 2);
  return Number.isFinite(v) ? v : dflt;
};
const MIN_PERIOD = opt('min-period', 4);
const MAX_PERIOD = opt('max-period', 40);
const TARGET_LUFS = opt('lufs', -24);
// The bed fades in at the start of the body rather than arriving at full level.
// Those first seconds are quieter than the loop proper, and since the
// reconstruction takes the QUIETEST observation per bin, including them drags
// the head of the loop down and leaves a step at the wrap. Skip them.
const LEAD = opt('lead', 2.6);

const [input, output = 'brand/music/academy-bed.wav'] = argv;
if (!input) {
  console.error(
    'usage: node tools/extract-bed.mjs <finished-lesson.mp4> [out.wav]\n' +
    '       [--min-period 4] [--max-period 40] [--lufs -24]',
  );
  process.exit(1);
}

const SR = 48000;
const N = 2048;
const HOP = 512;

// ---- decode ----
function pcm(channels) {
  const raw = execFileSync(
    FFMPEG,
    ['-v', 'error', '-i', input, '-map', '0:a:0', '-ac', String(channels),
      '-ar', String(SR), '-f', 's16le', '-'],
    { maxBuffer: 1 << 29 },
  );
  const total = Math.floor(raw.length / 2);
  const frames = Math.floor(total / channels);
  const out = Array.from({ length: channels }, () => new Float64Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) out[c][i] = raw.readInt16LE((i * channels + c) * 2) / 32768;
  }
  return out;
}

const [mono] = pcm(1);
const stereo = pcm(2);
const duration = mono.length / SR;
console.log(`${path.basename(input)} — ${duration.toFixed(1)}s`);

// ---- fft ----
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const window = new Float64Array(N);
for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

// ---- where the bed plays ----
// The opening and the outro are digital silence with only the transition cues
// on them; the bed runs under the body between.
const step = Math.round(SR * 0.05);
const level = [];
for (let i = 0; i + step <= mono.length; i += step) {
  let acc = 0;
  for (let k = 0; k < step; k++) acc += mono[i + k] * mono[i + k];
  level.push(10 * Math.log10(acc / step + 1e-12));
}
// The opening and the outro are digital silence with only the cues on them, and
// that silence must stay OUT of the window: it is the smallest thing in every
// bin, so the reconstruction would take it and punch a second of dead air
// through the middle of the loop. So the window starts after the last silent
// run in the opening and ends before the first one in the closing.
const silent = level.map((v) => v <= -70);
const runs = [];
for (let i = 0; i < silent.length; i++) {
  if (!silent[i]) continue;
  let j = i;
  while (j < silent.length && silent[j]) j++;
  if ((j - i) * step >= SR * 0.3) runs.push([i, j]);
  i = j - 1;
}

const head = runs.filter(([, b]) => (b * step) / SR < level.length * step / SR * 0.3);
const tail = runs.filter(([a]) => (a * step) / SR > level.length * step / SR * 0.7);

const fromFrame = head.length ? head[head.length - 1][1] : 0;
const toFrame = tail.length ? tail[0][0] : level.length;
const from = fromFrame * step + Math.round(LEAD * SR);
const to = toFrame * step;
console.log(
  `bed runs ${(fromFrame * step / SR).toFixed(2)}s to ${(to / SR).toFixed(2)}s; ` +
  `sampling from ${(from / SR).toFixed(2)}s after a ${LEAD}s lead-in`,
);

// ---- find the loop period ----
// Self-similarity of the spectrogram, restricted to the bed's own bands and
// whitened so it keys on what repeats rather than on how loud things are.
const specFrames = [];
{
  const lo = Math.round((35 / (SR / N)));
  const hi = Math.round((520 / (SR / N)));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = from; i + N < to; i += HOP) {
    for (let k = 0; k < N; k++) { re[k] = mono[i + k] * window[k]; im[k] = 0; }
    fft(re, im);
    const row = new Float64Array(hi - lo);
    for (let k = lo; k < hi; k++) row[k - lo] = Math.log(Math.hypot(re[k], im[k]) + 1e-8);
    specFrames.push(row);
  }
  const rows = specFrames.length;
  const cols = specFrames[0].length;
  const colMean = new Float64Array(cols);
  for (const r of specFrames) for (let c = 0; c < cols; c++) colMean[c] += r[c] / rows;
  for (const r of specFrames) {
    let m = 0;
    for (let c = 0; c < cols; c++) { r[c] -= colMean[c]; m += r[c]; }
    m /= cols;
    for (let c = 0; c < cols; c++) r[c] -= m;
  }
}

function similarityAt(lagFrames) {
  const rows = specFrames.length - lagFrames;
  if (rows < 40) return -1;
  const cols = specFrames[0].length;
  let acc = 0;
  for (let i = 0; i < rows; i += 2) {
    const a = specFrames[i];
    const b = specFrames[i + lagFrames];
    for (let c = 0; c < cols; c++) acc += a[c] * b[c];
  }
  return acc / (Math.ceil(rows / 2) * cols);
}

let coarse = { score: -1, lag: 0 };
for (let lag = Math.round((MIN_PERIOD * SR) / HOP); lag < Math.round((MAX_PERIOD * SR) / HOP); lag++) {
  const s = similarityAt(lag);
  if (s > coarse.score) coarse = { score: s, lag };
}
const coarseSamples = coarse.lag * HOP;
console.log(`loop candidate: ${(coarseSamples / SR).toFixed(3)}s (self-similarity ${coarse.score.toFixed(3)})`);

// Refine to the sample, over the stretches where the mix is quiet enough that
// the bed is most of what is there.
const quiet = new Uint8Array(mono.length);
for (let i = 0; i < level.length; i++) {
  if (level[i] < -30) quiet.fill(1, i * step, (i + 1) * step);
}
let period = coarseSamples;
{
  let best = { c: -1, lag: coarseSamples };
  for (let lag = coarseSamples - 3000; lag <= coarseSamples + 3000; lag++) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    let used = 0;
    for (let i = from; i + lag < to; i += 3) {
      if (!quiet[i] || !quiet[i + lag]) continue;
      const a = mono[i];
      const b = mono[i + lag];
      dot += a * b; na += a * a; nb += b * b; used++;
    }
    if (used < SR / 3) continue;
    const c = dot / (Math.sqrt(na * nb) + 1e-12);
    if (c > best.c) best = { c, lag };
  }
  period = best.lag;
  console.log(`refined period: ${period} samples = ${(period / SR).toFixed(6)}s (corr ${best.c.toFixed(3)})`);
}

// ---- how many whole repeats fit ----
const copies = Math.floor((to - from - N) / period);
if (copies < 3) {
  console.error(`only ${copies} whole repeat(s) fit — not enough to separate the bed`);
  process.exit(1);
}
console.log(`using ${copies} repeats`);

// ---- reconstruct one period ----
// Per bin, the smallest magnitude across the repeats is the bed. Phase comes
// from ONE repeat — the quietest in that frame — because choosing it per bin
// from different repeats destroys the coherence between bins and reconstructs
// as a burst of noise rather than a chord.
const out = stereo.map(() => new Float64Array(period));

for (let ch = 0; ch < stereo.length; ch++) {
  const x = stereo[ch];
  const span = period + 2 * N;
  const acc = new Float64Array(span);
  const wsum = new Float64Array(span);

  const re = Array.from({ length: copies }, () => new Float64Array(N));
  const im = Array.from({ length: copies }, () => new Float64Array(N));

  for (let f0 = 0; f0 + N <= span; f0 += HOP) {
    let base = 0;
    let bestEnergy = Infinity;

    for (let k = 0; k < copies; k++) {
      const off = from + k * period - N + f0;
      for (let i = 0; i < N; i++) {
        const s = off + i;
        re[k][i] = (s >= 0 && s < x.length ? x[s] : 0) * window[i];
        im[k][i] = 0;
      }
      fft(re[k], im[k]);
      let e = 0;
      for (let b = 0; b <= N / 2; b++) e += re[k][b] * re[k][b] + im[k][b] * im[k][b];
      if (e < bestEnergy) { bestEnergy = e; base = k; }
    }

    // minimum magnitude per bin, phase from `base`
    const er = new Float64Array(N);
    const ei = new Float64Array(N);
    for (let b = 0; b <= N / 2; b++) {
      let mag = Infinity;
      for (let k = 0; k < copies; k++) {
        const m = Math.hypot(re[k][b], im[k][b]);
        if (m < mag) mag = m;
      }
      const pr = re[base][b];
      const pi = im[base][b];
      const pm = Math.hypot(pr, pi) + 1e-12;
      er[b] = (pr / pm) * mag;
      ei[b] = (pi / pm) * mag;
      if (b > 0 && b < N / 2) { er[N - b] = er[b]; ei[N - b] = -ei[b]; }
    }

    fft(er, ei, true);
    for (let i = 0; i < N; i++) {
      acc[f0 + i] += er[i] * window[i];
      wsum[f0 + i] += window[i] * window[i];
    }
  }

  for (let i = 0; i < period; i++) {
    const w = wsum[i + N] < 1e-6 ? 1e-6 : wsum[i + N];
    out[ch][i] = acc[i + N] / w;
  }
}

// ---- write ----
fs.mkdirSync(path.dirname(output), { recursive: true });
const tmp = `${output}.raw.wav`;
{
  const frames = period;
  const ch = out.length;
  const data = Buffer.alloc(frames * ch * 2);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, out[c][i]));
      data.writeInt16LE(Math.round(v * 32767), (i * ch + c) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(ch, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * ch * 2, 28);
  header.writeUInt16LE(ch * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(tmp, Buffer.concat([header, data]));
}

// A gentle top-end roll-off: the pad has nothing above a few kHz, and whatever
// is up there is the take's hiss surviving the minimum. Then to a known level —
// the pipeline re-normalises anyway, but a file that is not absurdly quiet is
// easier to audition.
execFileSync(FFMPEG, [
  '-y', '-v', 'error', '-i', tmp,
  '-af', `lowpass=f=6000:poles=2,loudnorm=I=${TARGET_LUFS}:TP=-3:LRA=7,aresample=48000`,
  '-c:a', 'pcm_s16le', output,
]);
fs.rmSync(tmp);

console.log(
  `\nwrote ${output} — ${(period / SR).toFixed(3)}s, seamless by construction ` +
  '(exactly one period of the original loop)',
);
