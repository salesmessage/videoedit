// The soundtrack, built against the finished picture.
//
// Four things happen here. The narration is denoised and levelled to the same
// target every other lesson sits at, so a set of them plays back at one
// volume. It is delayed to where the recording actually starts, because the
// opening runs over it. The brand's transition cues are dropped in at the
// joins. And if there is a bed to lay underneath, it is ducked by the
// narration rather than mixed at a fixed level.
//
// On the cues: the hand-finished examples have no music bed at all. What
// sounds like one is three short cues — a swell under the logo build, a hit on
// the title card, a riser into the recording — playing over digital silence,
// plus a fourth on the outro. Both examples use the identical sounds (they
// cross-correlate at r > 0.98), so they are the brand's, and they are in
// brand/sfx, cut from the examples at points where nothing else is sounding.

import fs from 'node:fs';
import path from 'node:path';
import { run, probe, detect } from '../lib/ffmpeg.mjs';

const dbToGain = (db) => 10 ** (db / 20);

/** The first music file in the brand's music folder, if it holds one. */
export function findMusic(dir) {
  if (!fs.existsSync(dir)) return null;
  const f = fs
    .readdirSync(dir)
    .filter((n) => /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(n))
    .sort()[0];
  return f ? path.join(dir, f) : null;
}

/**
 * How loud the bed file already is, so it can be placed at a level rather than
 * nudged by a fixed gain. A track that arrives mastered at -9 LUFS and one that
 * arrives at -24 would otherwise land 15 dB apart under the same narration.
 */
export function musicGain(file, targetDb) {
  const log = detect([
    '-hide_banner', '-nostats', '-i', file,
    '-af', 'ebur128', '-f', 'null', '-',
  ]);
  const m = /Integrated loudness:[\s\S]*?I:\s*(-?[\d.]+) LUFS/.exec(log);
  const measured = m ? Number(m[1]) : null;
  if (!Number.isFinite(measured)) return { gainDb: targetDb + 16, measured: null };
  return { gainDb: targetDb - measured, measured };
}

// Where each cue's own peak sits inside its file. Cues are placed by their
// peak, not their start: what has to land on the beat is the hit, and the
// swell in front of it is a different length in each one.
export const CUES = {
  open: { file: 'open.wav', peak: 0.57 },
  title: { file: 'title.wav', peak: 0.32 },
  reveal: { file: 'reveal.wav', peak: 1.21 },
  close: { file: 'close.wav', peak: 0.04 },
};

/**
 * The cue list for a timeline: which sound, and when its hit should land.
 */
export function cuesFor(dir, timeline, frame) {
  if (!fs.existsSync(dir)) return [];

  const hits = {
    open: 0.45, // the mark landing on an empty field
    title: timeline.titleStart,
    reveal: timeline.bodyStart + frame.slideIn * 0.8,
    close: timeline.outroStart,
  };

  const out = [];
  for (const [name, cue] of Object.entries(CUES)) {
    const file = path.join(dir, cue.file);
    if (!fs.existsSync(file)) continue;
    const at = hits[name] - cue.peak;
    out.push({ name, file, at: Math.max(0, at), trim: at < 0 ? -at : 0 });
  }
  return out;
}

/**
 * Cleaning and levelling, up to but not including loudnorm.
 *
 * WHAT DID AND DID NOT WORK, because the obvious chain is the wrong one.
 *
 * A spectral denoiser is what you reach for, and on this library's takes it is
 * worth about half a decibel: what you hear between words is not hiss but
 * low-frequency room and mouse clicks. A downward expander does far better on
 * the gaps (-14 dB) and is still wrong — the quiet end of this narrator's
 * range sits inside the same band as the room, so the expander eats it, and
 * the variation between spoken phrases goes from 4.4 dB to 7.8 dB. That is a
 * worse fault than the noise: a viewer forgives room tone and does not forgive
 * a sentence they cannot hear.
 *
 * What works is not a level decision at all. The analyser already knows where
 * the narrator stopped talking, so those spans are ducked by name — see
 * `duckExpression` — and everything here can stay gentle.
 */
export function cleanChain(opts) {
  const stages = [];
  if (opts.highpass) {
    stages.push(`highpass=f=${opts.highpass}:poles=${opts.highpassPoles ?? 2}`);
  }
  if (opts.denoise) {
    const floor = Math.min(-20, Math.max(-80, Math.round(opts.noiseFloorDb)));
    stages.push(`afftdn=nr=${opts.denoiseDb}:nf=${floor}:tn=1`);
  }
  if (opts.filter) stages.push(opts.filter);
  if (opts.duck && opts.duckSpans?.length) stages.push(duckExpression(opts));
  return stages.join(',');
}

/**
 * Pull down the stretches where nobody is speaking.
 *
 * A gate keyed on level cannot do this on a take whose noise and quietest
 * speech overlap. But the spans are known — they were measured off the take
 * and remapped through the cut plan — so the gain can be automated against
 * them directly, which cannot touch speech by construction.
 *
 * Each span becomes a trapezoid with a short ramp at both ends; the gain is
 * one minus the deepest overlapping trapezoid. The expression is a few
 * thousand characters and is evaluated once per audio frame, which is nothing.
 */
export function duckExpression(opts) {
  const depth = 1 - 10 ** (-opts.duckDb / 20);
  const r = opts.duckRamp;

  // Shrink each span before ducking it: the analyser's edges are where the
  // envelope crossed a threshold, and the breath before a sentence starts
  // slightly before that.
  const spans = opts.duckSpans
    .map(([a, b]) => [a + opts.duckPad, b - opts.duckPad])
    .filter(([a, b]) => b - a >= Math.max(0.2, r * 1.5))
    .slice(0, opts.duckMaxSpans ?? 400);

  let expr = '0';
  for (const [a, b] of spans) {
    expr = `max(${expr},clip(min((t-${a.toFixed(2)})/${r},(${b.toFixed(2)}-t)/${r}),0,1))`;
  }
  // The single quotes have to reach ffmpeg: the expression is full of commas,
  // which the filtergraph parser would otherwise read as filter separators.
  return `volume=eval=frame:volume='1-${depth.toFixed(4)}*(${expr})'`;
}

/**
 * loudnorm, measured first.
 *
 * Single-pass loudnorm guesses, and on a quiet wide-range take it guesses low
 * — the cleaned narration came out at -21 LUFS against a -16 target, four
 * decibels under the hand-finished lessons. Measuring first and handing the
 * numbers back costs one audio-only pass and lands within half a decibel of
 * where the examples sit.
 */
export function measureLoudness(file, chain, target) {
  const log = detect([
    '-hide_banner', '-nostats',
    '-i', file, '-map', '0:a:0',
    '-af', `${chain},loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}:print_format=json`,
    '-f', 'null', '-',
  ]);

  const m = /\{[\s\S]*?\}/.exec(log);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const ok = (v) => Number.isFinite(Number(v));
    if (!['input_i', 'input_lra', 'input_tp', 'input_thresh'].every((k) => ok(j[k]))) return null;
    return j;
  } catch {
    return null; // an unreadable measurement just means single-pass
  }
}

function loudnormFor(target, measured) {
  const base = `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}`;
  if (!measured) return base;
  return (
    `${base}:measured_I=${measured.input_i}:measured_LRA=${measured.input_lra}` +
    `:measured_TP=${measured.input_tp}:measured_thresh=${measured.input_thresh}` +
    `:offset=${measured.target_offset ?? 0}:linear=true`
  );
}

/**
 * The narration, placed on the output timeline.
 *
 * The two asetpts are not decoration. loudnorm buffers ahead and hands its
 * output back on shifted timestamps, and resamples to 192 kHz on the way; a
 * later atrim measured in seconds then trims against those shifted stamps and
 * silently eats the delay — a seven-second desync that nothing reports as an
 * error. Resample once, restamp before delaying, restamp before trimming.
 */
function voiceChain(opts, offset, total) {
  const clean = cleanChain(opts);
  return (
    `[1:a]${clean ? `${clean},` : ''}${loudnormFor(opts.loudness, opts.measured)},` +
    `aresample=48000,asetpts=N/SR/TB,` +
    `adelay=${Math.round(offset * 1000)}:all=1,apad,` +
    `asetpts=N/SR/TB,atrim=0:${total.toFixed(3)}[voice]`
  );
}

export function buildAudio({ picture, body, output, music, cues = [], offset, total, opts }) {
  const inputs = ['-i', picture, '-i', body];
  const filters = [voiceChain(opts, offset, total)];
  const layers = [];
  let next = 2;

  if (music) {
    // The bed runs under the recording and nowhere else. In the examples the
    // opening, the title card and the outro are digital silence with only the
    // transition cues on them — the bed starts as the recording arrives and
    // stops as the outro dissolves in.
    const from = opts.bedFrom ?? offset;
    const until = opts.bedUntil ?? total;
    const len = Math.max(0.1, until - from);
    inputs.push('-stream_loop', '-1', '-i', music);
    filters.push(
      `[${next}:a]aresample=48000,asetpts=N/SR/TB,atrim=0:${len.toFixed(3)},` +
        `volume=${dbToGain(opts.musicGainDb).toFixed(4)},` +
        `afade=t=in:st=0:d=${opts.musicFade},` +
        `afade=t=out:st=${Math.max(0, len - opts.musicFade).toFixed(3)}:d=${opts.musicFade},` +
        `adelay=${Math.round(from * 1000)}:all=1,apad,` +
        `asetpts=N/SR/TB,atrim=0:${total.toFixed(3)},` +
        `aformat=channel_layouts=stereo[bed]`,
    );
    next++;

    // Ducking is optional, and off by default, because the bed is already
    // ~17 dB under the narration. Side-chaining something that quiet does not
    // make room for the voice — it makes the bed pump, and it leaves the gaps
    // emptier than the examples', which hold a steady pad right through.
    if (opts.musicDuckDb > 0) {
      // sidechaincompress needs the key signal twice — once as the thing being
      // ducked, once as what does the ducking — so the voice is split.
      filters.push('[voice]asplit=2[voice1][key]');
      filters.push(
        `[bed][key]sidechaincompress=threshold=0.05:ratio=4:attack=30:release=250:` +
          `makeup=1:level_sc=${dbToGain(-opts.musicDuckDb).toFixed(4)}[ducked]`,
      );
      layers.push('[voice1]', '[ducked]');
    } else {
      layers.push('[voice]', '[bed]');
    }
  } else {
    layers.push('[voice]');
  }

  for (const cue of cues) {
    inputs.push('-i', cue.file);
    const label = `sfx${next}`;
    filters.push(
      `[${next}:a]` +
        (cue.trim ? `atrim=start=${cue.trim.toFixed(3)},asetpts=N/SR/TB,` : '') +
        `volume=${dbToGain(opts.sfxDb).toFixed(4)},aresample=48000,` +
        `aformat=channel_layouts=stereo,adelay=${Math.round(cue.at * 1000)}:all=1[${label}]`,
    );
    layers.push(`[${label}]`);
    next++;
  }

  // amix normalises by input count unless told not to, which would drop the
  // narration by 6 dB the moment a cue is added.
  const mixed = layers.length > 1 ? '[mix]' : layers[0];
  if (layers.length > 1) {
    filters.push(`${layers.join('')}amix=inputs=${layers.length}:duration=first:normalize=0[mix]`);
  }

  filters.push(
    `${mixed}afade=t=in:st=0:d=${opts.fadeIn},` +
      `afade=t=out:st=${Math.max(0, total - opts.fadeOut).toFixed(3)}:d=${opts.fadeOut},` +
      `alimiter=limit=0.97,` +
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[out]',
  );

  run([
    '-y', '-v', 'error',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '0:v:0',
    '-map', '[out]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', opts.bitrate,
    // Not -shortest: the picture is the authority on length, and a filtered
    // audio graph that ends a frame early would otherwise truncate it.
    '-t', total.toFixed(3),
    '-movflags', '+faststart',
    output,
  ], { label: 'audio mux' });
}

/**
 * Confirm the two streams came out the length they were asked for.
 *
 * An audio filtergraph that quietly loses its delay produces a file that
 * plays, muxes and reports no error — the narration simply starts seven
 * seconds early, over the title card, and stays wrong for the whole lesson.
 * Nothing downstream notices, so the check belongs here.
 */
export function verify(file, { total, tolerance = 0.25 }) {
  const v = probe(file);
  const problems = [];
  if (Math.abs(v.duration - total) > tolerance) {
    problems.push(`container is ${v.duration.toFixed(2)}s, expected ${total.toFixed(2)}s`);
  }
  if (!v.hasAudio) problems.push('no audio stream');
  if (problems.length) throw new Error(`output is wrong: ${problems.join('; ')}`);
  return v;
}

/** No usable audio in the take: still lay the cues over a silent bed. */
export function muxSilent({ picture, output, cues = [], total, opts }) {
  const inputs = ['-i', picture, '-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo'];
  const filters = [];
  const layers = ['[1:a]'];
  let next = 2;

  for (const cue of cues) {
    inputs.push('-i', cue.file);
    filters.push(
      `[${next}:a]volume=${dbToGain(opts.sfxDb).toFixed(4)},aresample=48000,` +
        `aformat=channel_layouts=stereo,adelay=${Math.round(cue.at * 1000)}:all=1[sfx${next}]`,
    );
    layers.push(`[sfx${next}]`);
    next++;
  }

  filters.push(
    `${layers.join('')}amix=inputs=${layers.length}:duration=first:normalize=0,` +
      `atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,` +
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[out]',
  );

  run([
    '-y', '-v', 'error',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '0:v:0', '-map', '[out]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', opts.bitrate,
    '-t', total.toFixed(3), '-movflags', '+faststart',
    output,
  ], { label: 'silent mux' });
}
