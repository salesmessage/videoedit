// Applying the cut plan to the take.
//
// Both streams are cut in one filtergraph, from one input, in one pass. That
// is not an optimisation — it is why nothing can drift. Cutting picture and
// sound separately and re-joining them means two lists of timestamps that have
// to stay identical, and they do not stay identical for long.
//
// Output is a plain intermediate: high bit rate, fast preset, thrown away at
// the end. Quality is spent in the final encode, not here.

import path from 'node:path';
import { run, probe } from '../lib/ffmpeg.mjs';

export function applyCuts({ input, output, segments, hasAudio, fps }) {
  // Nothing to do: hand back the source and let the caller skip a whole encode.
  if (segments.length === 1 && segments[0].speed === 1 && segments[0].from === 0) {
    return { file: input, reencoded: false };
  }

  const parts = [];
  const vLabels = [];
  const aLabels = [];

  segments.forEach((s, i) => {
    parts.push(
      `[0:v]trim=start=${s.from.toFixed(4)}:end=${s.to.toFixed(4)},` +
        `setpts=(PTS-STARTPTS)/${s.speed}[v${i}]`,
    );
    vLabels.push(`[v${i}]`);

    if (!hasAudio) return;
    // atempo is capped at 2x per instance, and a dead run may be played at
    // four. Chaining keeps the pitch right where a single stage would refuse.
    let rate = s.speed;
    const tempo = [];
    while (rate > 2.0001) { tempo.push('atempo=2.0'); rate /= 2; }
    if (Math.abs(rate - 1) > 1e-4) tempo.push(`atempo=${rate.toFixed(6)}`);
    parts.push(
      `[0:a]atrim=start=${s.from.toFixed(4)}:end=${s.to.toFixed(4)},asetpts=PTS-STARTPTS` +
        (tempo.length ? `,${tempo.join(',')}` : '') +
        `[a${i}]`,
    );
    aLabels.push(`[a${i}]`);
  });

  const n = segments.length;
  parts.push(
    hasAudio
      ? `${vLabels.map((v, i) => v + aLabels[i]).join('')}concat=n=${n}:v=1:a=1[vo][ao]`
      : `${vLabels.join('')}concat=n=${n}:v=1:a=0[vo]`,
  );

  const args = [
    '-y', '-v', 'error',
    '-i', input,
    '-filter_complex', parts.join(';'),
    '-map', '[vo]',
    ...(hasAudio ? ['-map', '[ao]'] : []),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
    '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'pcm_s16le'] : []),
    '-f', 'matroska', // pcm audio in an mkv: an intermediate, not a deliverable
    output,
  ];

  run(args, { label: 'tighten' });
  return { file: output, reencoded: true, ...probe(output) };
}
