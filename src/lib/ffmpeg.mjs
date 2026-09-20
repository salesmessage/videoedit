// Every call into ffmpeg/ffprobe goes through here.
//
// Two reasons it is one module. The binaries are found once, so a machine
// where ffmpeg lives outside PATH is fixed by setting FFMPEG rather than by
// editing five call sites. And ffmpeg's habit of reporting on stderr while
// still exiting 0 needs handling in exactly one place: `detect()` below wants
// that stderr on success, everything else wants it only on failure.

import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG || 'ffmpeg';
export const FFPROBE =
  process.env.FFPROBE ||
  (process.env.FFMPEG
    ? path.join(
        path.dirname(process.env.FFMPEG),
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
      )
    : 'ffprobe');

const missing = (bin) =>
  new Error(
    `${path.basename(bin)} not found (tried "${bin}"). Install ffmpeg ` +
      '(winget install Gyan.FFmpeg) or point FFMPEG at the binary.',
  );

/** Run ffmpeg to completion. Throws with the tail of stderr if it fails. */
export function run(args, { bin = FFMPEG, label = 'ffmpeg' } = {}) {
  try {
    execFileSync(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === 'ENOENT') throw missing(bin);
    throw new Error(`${label} failed:\n${err.stderr?.toString().slice(-2000) ?? err.message}`);
  }
}

/**
 * Run an analysis pass and hand back stderr. Filters like silencedetect write
 * their findings there and still exit 0, which execFileSync hides.
 */
export function detect(args) {
  const res = spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.error?.code === 'ENOENT') throw missing(FFMPEG);
  if (res.status !== 0) {
    throw new Error(`detection pass failed:\n${(res.stderr ?? '').slice(-2000)}`);
  }
  return res.stderr ?? '';
}

/** Spawn ffmpeg for streaming, with a comprehensible error if it is absent. */
export function stream(args, { bin = FFMPEG } = {}) {
  const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  p.on('error', (err) => {
    console.error(err.code === 'ENOENT' ? missing(bin).message : err);
    process.exit(1);
  });
  return p;
}

/** Width, height, fps, duration and stream presence for a media file. */
export function probe(file) {
  let raw;
  try {
    raw = execFileSync(
      FFPROBE,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    if (err.code === 'ENOENT') throw missing(FFPROBE);
    throw err;
  }

  const j = JSON.parse(raw);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error(`no video stream in ${file}`);

  const [num, den] = String(v.r_frame_rate).split('/').map(Number);
  const fps = den ? num / den : num || 30;
  const duration = Number(j.format?.duration) || 0;

  return {
    file,
    width: v.width,
    height: v.height,
    fps,
    duration,
    hasAudio: Boolean(a),
    audioChannels: a ? Number(a.channels) : 0,
    frames: Number(v.nb_frames) || Math.round(duration * fps),
  };
}

export function durationOf(file) {
  const out = execFileSync(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  const d = Number(out.toString().trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`could not read duration of ${file}`);
  return d;
}
