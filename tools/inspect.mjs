#!/usr/bin/env node
// Measuring a finished lesson, the same way every time.
//
//   node tools/inspect.mjs frame  <file.mp4> [more.mp4 …]   container, card, loudness, pacing
//   node tools/inspect.mjs audio  <file.mp4> [more.mp4 …]   quiet level and phrase-to-phrase spread
//   node tools/inspect.mjs audio  <reference> <file> [...]  … all measured against one speech map
//   node tools/inspect.mjs opening [outDir]                 render the logo build, print glyph positions
//
// These exist because the look was matched to the hand-finished examples by
// measurement, and the only way to know it still matches after a change is to
// take the same measurement again. Eyeballing a frame is how "close enough"
// becomes nine pixels out.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { probe, detect, FFMPEG } from '../src/lib/ffmpeg.mjs';
import { audioTrack } from '../src/stages/analyse.mjs';

const [command, ...rest] = process.argv.slice(2);

const usage = () => {
  console.error(
    'usage: node tools/inspect.mjs <frame|audio|opening> [files…]\n' +
    '  frame    container, card geometry, loudness, pacing\n' +
    '  audio    level where nobody speaks, and variation between spoken phrases\n' +
    '  opening  render the logo build and print where every glyph landed',
  );
  process.exit(1);
};

// ---- frame ----

/** The recording's card, found as the strongest straight edges in a frame. */
function cardRect(file, at) {
  const W = 1920;
  const H = 1080;
  const raw = execFileSync(
    FFMPEG,
    ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
      '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 1 << 26 },
  );
  if (raw.length < W * H) return null;

  const col = new Float64Array(W);
  const row = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 1; x < W; x++) col[x] += Math.abs(raw[y * W + x] - raw[y * W + x - 1]);
  }
  for (let y = 1; y < H; y++) {
    for (let x = 0; x < W; x++) row[y] += Math.abs(raw[y * W + x] - raw[(y - 1) * W + x]);
  }
  const pick = (arr) => {
    const max = Math.max(...arr);
    const hits = [];
    for (let i = 0; i < arr.length; i++) if (arr[i] > max * 0.25) hits.push(i);
    return hits.length ? [hits[0], hits[hits.length - 1]] : null;
  };
  const xs = pick(col);
  const ys = pick(row);
  return xs && ys ? { x: xs[0], y: ys[0], w: xs[1] - xs[0], h: ys[1] - ys[0] } : null;
}

function loudness(file) {
  const log = detect(['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const grab = (re) => {
    const m = re.exec(log);
    return m ? Number(m[1]) : NaN;
  };
  return {
    I: grab(/Integrated loudness:[\s\S]*?I:\s*(-?[\d.]+) LUFS/),
    LRA: grab(/Loudness range:[\s\S]*?LRA:\s*(-?[\d.]+) LU/),
    TP: grab(/True peak:[\s\S]*?Peak:\s*(-?[\d.]+) dBFS/),
  };
}

function envelope(file) {
  const sr = 16000;
  const raw = execFileSync(
    FFMPEG,
    ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'],
    { maxBuffer: 1 << 28 },
  );
  const span = sr * 0.05;
  const out = [];
  for (let i = 0; i + span <= raw.length / 2; i += span) {
    let acc = 0;
    for (let j = 0; j < span; j++) {
      const s = raw.readInt16LE((i + j) * 2) / 32768;
      acc += s * s;
    }
    out.push(10 * Math.log10(acc / span + 1e-12));
  }
  return out;
}

function inspectFrame(files) {
  for (const file of files) {
    const v = probe(file);
    const env = envelope(file);
    const at = (i) => (i * 0.05).toFixed(2);

    let firstQuiet = -1;
    for (let i = 20; i < env.length - 20; i++) {
      if (env.slice(i, i + 12).every((d) => d < -70)) { firstQuiet = i; break; }
    }
    let lastSound = env.length - 1;
    while (lastSound > 0 && env[lastSound] < -70) lastSound--;

    // Sample several plain-body moments and keep the reading that repeats: one
    // probe can land inside a zoom or a list section and measure that instead.
    const tally = new Map();
    for (const f of [0.25, 0.4, 0.55, 0.7, 0.85]) {
      const r = cardRect(file, v.duration * f);
      if (!r) continue;
      const key = `${r.x},${r.y},${r.w},${r.h}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const card = best ? best[0].split(',').map(Number) : null;
    const l = loudness(file);

    console.log(`\n${path.basename(file)}`);
    console.log(`  ${v.width}x${v.height} @ ${v.fps.toFixed(2)}fps  ${v.duration.toFixed(1)}s  ${v.audioChannels}ch`);
    console.log(`  card         ${card ? `x${card[0]} y${card[1]} ${card[2]}x${card[3]}` : 'not found'}`);
    console.log(`  loudness     ${l.I.toFixed(1)} LUFS   LRA ${l.LRA.toFixed(1)}   peak ${l.TP.toFixed(1)} dBTP`);
    console.log(`  opening gap  silence at ${firstQuiet > 0 ? at(firstQuiet) : '?'}s`);
    console.log(`  tail silence ${(v.duration - lastSound * 0.05).toFixed(1)}s`);
  }
}

// ---- audio ----

async function inspectAudio(args) {
  // One argument: each file measured against its own speech map, which is the
  // only way to compare finished videos whose timelines differ. Two or more:
  // the first supplies the map for all of them — use that to compare
  // treatments of the same take.
  const shared = args.length > 1 ? await audioTrack(args[0]) : null;
  const files = args.length > 1 ? args.slice(1) : args;

  const db = (v) => 20 * Math.log10(v + 1e-12);
  const pct = (arr, p) => arr.slice().sort((x, y) => x - y)[Math.floor(p * (arr.length - 1))];

  for (const file of files) {
    const map = shared ?? await audioTrack(file);
    const sr = 16000;
    const raw = execFileSync(
      FFMPEG,
      ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'],
      { maxBuffer: 1 << 28 },
    );
    const n = Math.floor(raw.length / 2);
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = raw.readInt16LE(i * 2) / 32768;

    const rms = (a, b) => {
      const i0 = Math.max(0, Math.round(a * sr));
      const i1 = Math.min(d.length, Math.round(b * sr));
      if (i1 - i0 < sr * 0.05) return null;
      let acc = 0;
      for (let i = i0; i < i1; i++) acc += d[i] * d[i];
      return Math.sqrt(acc / (i1 - i0));
    };

    const spoken = map.speech.map(([a, b]) => rms(a, b)).filter(Boolean).map(db);
    const quiet = map.silence
      .filter(([a, b]) => b - a >= 0.5)
      .map(([a, b]) => rms(a + 0.15, b - 0.15))
      .filter(Boolean)
      .map(db);

    console.log(
      `${path.basename(file).padEnd(30)} ` +
      `quiet ${pct(quiet, 0.5).toFixed(1).padStart(6)} dBFS   ` +
      `speech ${pct(spoken, 0.5).toFixed(1).padStart(6)} dBFS   ` +
      `spread ${(pct(spoken, 0.9) - pct(spoken, 0.1)).toFixed(1).padStart(5)} dB`,
    );
  }
}

// ---- opening ----

async function inspectOpening(args) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { readStyleGuide, registerBrandFonts, resolveFont, loadArt } = await import('../src/lib/brand.mjs');
  const { createBackground } = await import('../src/lib/background.mjs');
  const { drawOpening } = await import('../src/lib/cards.mjs');
  const { DEFAULTS } = await import('../src/lib/config.mjs');
  const { ROOT, WORK } = await import('../src/lib/paths.mjs');

  const outDir = args[0] ?? path.join(WORK, 'opening');
  fs.mkdirSync(outDir, { recursive: true });

  registerBrandFonts();
  const style = readStyleGuide();
  const art = await loadArt();
  console.log('logo glyphs:', art.glyphs.map((g) => `${g.x}+${g.w}`).join(' '));

  const W = DEFAULTS.width;
  const H = DEFAULTS.height;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const bg = createBackground({ width: W, height: H, blue: style.blue, options: DEFAULTS.background });
  const s = { ...DEFAULTS.intro, wordFont: resolveFont(style.bodyFont, 'body'), word: 'academy' };

  console.log('  t     mark  glyph left edges');
  for (const t of [1.4, 1.55, 1.65, 1.75, 1.85, 1.95, 2.05, 2.15, 2.25, 2.45, 2.65, 3.5]) {
    bg(ctx, t, Math.round(t * 30));
    drawOpening(ctx, t, { art, style: s, width: W, height: H, alpha: 1 });
    fs.writeFileSync(path.join(outDir, `${t.toFixed(2)}.png`), canvas.toBuffer('image/png'));

    const { data } = ctx.getImageData(0, 470, W, 130);
    const runs = [];
    let start = null;
    for (let x = 0; x < W; x++) {
      let ink = false;
      for (let y = 0; y < 130; y++) {
        const i = (y * W + x) * 4;
        if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 215) { ink = true; break; }
      }
      if (ink && start === null) start = x;
      if (!ink && start !== null) {
        if (x - start >= 4) runs.push(start);
        start = null;
      }
    }
    console.log(`  ${t.toFixed(2)}  ${String(runs[0] ?? '-').padStart(4)}  ${runs.slice(1).join(' ')}`);
  }
  console.log(`\nframes in ${path.relative(ROOT, outDir)}`);
}

// ---- dispatch ----
if (command === 'frame') {
  if (!rest.length) usage();
  inspectFrame(rest);
} else if (command === 'audio') {
  if (!rest.length) usage();
  await inspectAudio(rest);
} else if (command === 'opening') {
  await inspectOpening(rest);
} else {
  usage();
}
