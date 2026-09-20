// Replacing the narration on a take that already has one.
//
// The pipeline this borrows its TTS from had an easier job: it wrote the script
// first and recorded silent footage, so a line could be as long as it liked and
// the picture waited. Here the picture already exists and was cut to a human
// reading at their own pace, so every synthesised line has to land where the
// original one did or it stops describing what is on screen.
//
// That is the whole problem this module solves. A synthesised line is rarely
// the same length as the one it replaces — across this library ElevenLabs runs
// a little long — so each line is anchored to its original start and then, only
// where it would collide with the next one, compressed. Compression is capped:
// past about 1.15x the voice starts to sound hurried, and a hurried line that
// is in sync is worse than a calm one that is a quarter-second late.
//
// What comes out is a new audio track on the source's own timeline, muxed
// against the untouched video, so every later stage — tightening, zoom,
// ducking — sees an ordinary take and needs to know nothing about any of this.

import fs from 'node:fs';
import path from 'node:path';
import { run, detect, durationOf, probe } from '../lib/ffmpeg.mjs';
import { speak } from '../lib/tts.mjs';

/**
 * Whisper breaks on breath, not on grammar, so its chunks are not lines.
 *
 * Turning them into lines needs a time for each one, and that is the part worth
 * being careful about. A chunk often holds two sentences and a sentence often
 * spans two chunks, so handing every sentence its parent chunk's start and end
 * gives several lines the same timestamp and spans that add up to more than the
 * lesson lasts. The times have to be interpolated *within* a chunk, which means
 * carrying a time per character and reading each sentence's own ends off it.
 *
 * Whisper also emits chunks that overlap each other, so they are ordered and
 * clipped first — otherwise the interpolation runs backwards.
 */
export function linesFrom(segments, { maxChars = 300 } = {}) {
  const ordered = [...segments]
    .filter((s) => s.text && Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start);
  if (!ordered.length) return [];

  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    s.end = Math.max(s.end ?? s.start, s.start + 0.05);
    const next = ordered[i + 1];
    if (next && next.start < s.end) s.end = Math.max(s.start + 0.05, next.start);
  }

  // One entry per character of the joined transcript, holding the moment that
  // character was spoken.
  let text = '';
  const when = [];
  for (const s of ordered) {
    const piece = (text ? ' ' : '') + s.text.trim();
    for (let k = 0; k < piece.length; k++) {
      const f = piece.length > 1 ? k / (piece.length - 1) : 0;
      when.push(s.start + (s.end - s.start) * f);
    }
    text += piece;
  }

  const lines = [];
  let from = 0;
  const push = (to) => {
    const body = text.slice(from, to).trim();
    if (body && /[a-z0-9]/i.test(body)) {
      // Leading whitespace was trimmed off the text, so walk the index forward
      // by the same amount to keep the time honest.
      let a = from;
      while (a < to && /\s/.test(text[a])) a++;
      lines.push({ text: body, start: when[a] ?? when[from] ?? 0, end: when[to - 1] ?? when[a] ?? 0 });
    }
    from = to;
  };

  for (let i = 0; i < text.length; i++) {
    if (/[.!?]/.test(text[i])) {
      // Not a full stop if it is a decimal or an initial: "1.3", "U.S."
      const prev = text[i - 1];
      const next = text[i + 1];
      if (text[i] === '.' && /\d/.test(prev ?? '') && /\d/.test(next ?? '')) continue;
      while (i + 1 < text.length && /[.!?"')\]]/.test(text[i + 1])) i++;
      push(i + 1);
    } else if (i - from >= maxChars && /\s/.test(text[i])) {
      // A sentence that never gets its full stop would otherwise swallow the
      // rest of the lesson into one clip.
      push(i);
    }
  }
  push(text.length);

  return lines;
}

/**
 * Confirm the take's own voice is not still in there.
 *
 * The invariant is simple and it is the one that matters: between one placed
 * line and the next there is nothing but the silent bed, so those spans must
 * measure as silence. If the original narration leaked through, it is speaking
 * in them — it was never aligned to the new line positions.
 *
 * Returns a description of the problem, or null when the track is clean. This
 * exists because the bug it catches does not fail anything: ffmpeg is happy,
 * the file plays, the durations are right, and a transcript of the result even
 * reads correctly — because the *old* voice is the one being transcribed.
 */
function checkReplaced(file, placed, total) {
  const PAD = 0.35; // keep clear of a line's own head and tail
  const gaps = [];
  let cursor = 0;
  for (const c of placed) {
    if (c.at - cursor > PAD * 2 + 0.5) gaps.push([cursor + PAD, c.at - PAD]);
    cursor = Math.max(cursor, c.at + c.played);
  }
  if (total - cursor > PAD * 2 + 0.5) gaps.push([cursor + PAD, total - PAD]);
  if (!gaps.length) return null; // wall-to-wall speech, nothing to measure

  const worst = { db: -Infinity, at: 0 };
  for (const [a, b] of gaps.slice(0, 40)) {
    const log = detect([
      '-hide_banner', '-nostats',
      '-ss', a.toFixed(3), '-to', b.toFixed(3), '-i', file,
      '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-',
    ]);
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(log);
    if (!m) continue;
    const db = Number(m[1]);
    if (db > worst.db) { worst.db = db; worst.at = a; }
  }

  // The bed is digital silence and a clip's tail is far below this, so anything
  // this loud between lines is another voice.
  const LIMIT = -50;
  if (worst.db > LIMIT) {
    return `${worst.db.toFixed(1)} dB of audio at ${worst.at.toFixed(1)}s, ` +
      `where there should be silence (limit ${LIMIT} dB)`;
  }
  return null;
}

/** Integrated loudness of one clip, or null if it is too quiet to measure. */
function loudnessOf(file) {
  const log = detect([
    '-hide_banner', '-nostats', '-i', file,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=summary',
    '-f', 'null', '-',
  ]);
  const m = /Input Integrated:\s*(-?[\d.]+) LUFS/.exec(log);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > -70 ? v : null;
}

/**
 * Lay the rendered lines out on the source's timeline.
 *
 * Each line wants to start where the original did. It may only be moved by
 * being *delayed*, never brought forward — the picture cuts to whatever the
 * line is about at that moment, and a line that arrives early describes
 * something not yet on screen.
 */
export function placeLines(clips, { duration, opts }) {
  let cursor = 0;
  let worst = 0;

  const placed = clips.map((c, i) => {
    const at = Math.max(c.start, cursor);
    const nextStart = clips[i + 1] ? clips[i + 1].start : duration;
    // The room this line has before the next one is due.
    const slot = Math.max(0.4, nextStart - at - opts.gap);

    let tempo = 1;
    if (c.duration > slot) tempo = Math.min(opts.maxTempo, c.duration / slot);
    const played = c.duration / tempo;

    const drift = at - c.start;
    worst = Math.max(worst, drift);
    cursor = at + played + opts.gap;

    return { ...c, at, tempo, played, drift };
  });

  return { placed, worstDrift: worst, end: cursor };
}

/**
 * Whisper hears a product name it has never seen and writes down the words it
 * sounds like: "sales message" for Salesmsg, "Owlbound" for Outbound. On the
 * old pipeline that cost nothing, because the transcript was only ever read by
 * the list detector, which is looking at sentence shape and does not care. Here
 * the transcript is the script — whatever is in it gets spoken aloud — so a
 * mishearing that was invisible becomes the narrator saying the wrong name.
 *
 * Correcting it belongs here rather than in the transcript, because the
 * transcript is a measurement of what the original narrator said and stays
 * true. Matching is case-insensitive and, where the phrase ends in a word
 * character, bounded — so "care" as a fix cannot rewrite "careful".
 */
export function applyFixes(text, fixes) {
  if (!fixes) return text;
  let out = text;
  for (const [from, to] of Object.entries(fixes)) {
    if (!from) continue;
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lead = /^\w/.test(from) ? '\\b' : '';
    const tail = /\w$/.test(from) ? '\\b' : '';
    out = out.replace(new RegExp(`${lead}${esc}${tail}`, 'gi'), to);
  }
  return out;
}

/**
 * Render, level, place and mux. Returns the new take plus a report.
 */
export async function narrate({
  input, output, segments, provider, cacheDir, opts, onProgress,
}) {
  const v = probe(input);
  let lines = linesFrom(segments);
  if (!lines.length) throw new Error('nothing to narrate — the transcript is empty');

  // Names first: the cache is keyed on the text that is spoken, so a fix has to
  // land before speak() or the corrected line comes back from the cache with
  // the mishearing still in it.
  let corrected = 0;
  for (const line of lines) {
    const fixed = applyFixes(line.text, opts.fixes);
    if (fixed !== line.text) corrected++;
    line.text = fixed;
  }

  // A fix that empties a line is how a hallucination gets removed — whisper
  // will occasionally emit a word nobody said, and the only correct thing to
  // speak in its place is nothing. Dropping it here rather than sending an
  // empty string keeps it out of the cache and off the bill.
  const dropped = lines.length;
  lines = lines.filter((l) => l.text.trim());
  if (!lines.length) throw new Error('every narration line was emptied by narration.fixes');

  // ---- render ----
  const clips = [];
  let billed = 0;
  let fromCache = 0;
  let debreathed = 0;

  for (const [i, line] of lines.entries()) {
    const r = await speak(provider, line.text, cacheDir);
    if (r.cached) fromCache++; else billed++;
    if (r.trimmedMs > 0) debreathed++;
    clips.push({ ...line, ...r });
    if (onProgress) onProgress(i + 1, lines.length, r.cached);
  }

  // ---- level every clip to a common loudness ----
  //
  // The provider does not return lines at a consistent level: short ones come
  // back several LU quieter. One dynamic pass over the finished mix cannot fix
  // that — it rides the whole track, so a quiet line inside a well-levelled
  // track stays quiet relative to its neighbours, heard as the narration
  // dropping away for a sentence. A static per-clip gain moves whole lines and
  // changes nothing about the delivery inside one.
  const measured = [];
  for (const c of clips) {
    const lufs = loudnessOf(c.file);
    c.lufs = lufs;
    c.gainDb = lufs === null
      ? 0
      : Math.max(-opts.maxGainDb, Math.min(opts.maxGainDb, opts.premixLufs - lufs));
    if (lufs !== null) measured.push(lufs);
  }
  const spread = measured.length > 1 ? Math.max(...measured) - Math.min(...measured) : 0;

  // ---- place ----
  const { placed, worstDrift, end } = placeLines(clips, { duration: v.duration, opts });
  const compressed = placed.filter((c) => c.tempo > 1.001).length;

  // ---- mix onto a silent bed of the take's own length ----
  //
  // INPUT 0 IS THE TAKE, AND ITS AUDIO MUST NEVER REACH THE MIX. Only the
  // picture is taken from it; the new track is built from a silent bed plus the
  // clips. Getting that wrong does not fail — it produces a video with two
  // narrators talking over each other, which is what happened when this list
  // started at `[0:a]`.
  //
  // Indices are therefore tracked explicitly rather than derived from the loop
  // counter. The same arithmetic that let the original audio in also shifted
  // every clip by one input, so each line played the previous line's audio and
  // the last line was dropped entirely.
  const total = Math.max(v.duration, end + 0.5);
  const inputs = [];
  const chains = [];
  const labels = [];

  let index = 1; // 0 is the take, and only its video is mapped
  inputs.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  labels.push(`[${index++}:a]`);

  for (const c of placed) {
    inputs.push('-i', c.file);
    const at = index++;

    const stages = [];
    if (Math.abs(c.gainDb) >= 0.1) stages.push(`volume=${c.gainDb.toFixed(2)}dB`);
    // atempo is capped at 2x per instance; nothing here goes near that, but the
    // chain keeps the pitch right whatever maxTempo is set to.
    let rate = c.tempo;
    while (rate > 2.0001) { stages.push('atempo=2.0'); rate /= 2; }
    if (Math.abs(rate - 1) > 1e-4) stages.push(`atempo=${rate.toFixed(6)}`);
    stages.push('aresample=48000', 'aformat=channel_layouts=stereo');
    stages.push(`adelay=${Math.round(c.at * 1000)}:all=1`);

    chains.push(`[${at}:a]${stages.join(',')}[n${at}]`);
    labels.push(`[n${at}]`);
  }

  chains.push(
    `${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0,` +
      `atrim=0:${total.toFixed(3)},asetpts=N/SR/TB[out]`,
  );

  run([
    '-y', '-v', 'error',
    '-i', input,
    ...inputs,
    '-filter_complex', chains.join(';'),
    // 0:v:0 and nothing else from input 0.
    '-map', '0:v:0', '-map', '[out]',
    // The picture is untouched — this is a mux, not a render.
    '-c:v', 'copy', '-c:a', 'pcm_s16le',
    '-t', total.toFixed(3),
    '-f', 'matroska', output,
  ], { label: 'narration mux' });

  // ---- prove the old voice is gone ----
  const leak = checkReplaced(output, placed, total);
  if (leak) {
    throw new Error(
      `the original narration survived the replacement: ${leak}\n` +
        'Nothing but 0:v:0 may be taken from the take — check the filtergraph ' +
        'input indices in narrate.mjs.',
    );
  }

  return {
    file: output,
    lines: placed,
    billed,
    fromCache,
    debreathed,
    corrected,
    dropped: dropped - lines.length,
    spread,
    compressed,
    worstDrift,
    duration: durationOf(output),
    characters: lines.reduce((s, l) => s + l.text.length, 0),
  };
}
