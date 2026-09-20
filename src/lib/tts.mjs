// Text to speech, with a cache that makes re-runs free.
//
// Provider comes from DEMO_TTS, else from whichever key is set:
//   ELEVENLABS_API_KEY -> elevenlabs      OPENAI_API_KEY -> openai
// Keys resolve through the shell or the project's .env — never a committed
// file. This is the same arrangement as the demo pipeline this project borrows
// from, so one .env serves both.
//
// Every clip is content-addressed by provider + voice + settings + text. A
// re-render after changing the title card, the zoom, or anything else in the
// pipeline therefore costs nothing and re-bills nothing; only edited lines are
// spoken again.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { FFMPEG, durationOf } from './ffmpeg.mjs';

const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // "Rachel"

export function pickProvider(opts = {}) {
  const forced = opts.provider ?? process.env.DEMO_TTS ?? null;
  const voiceOverride = opts.voice ?? process.env.DEMO_TTS_VOICE ?? null;

  const name =
    forced ||
    (process.env.ELEVENLABS_API_KEY ? 'elevenlabs'
      : process.env.OPENAI_API_KEY ? 'openai' : null);

  if (!name) {
    throw new Error(
      'no text-to-speech key found. Put ELEVENLABS_API_KEY in .env at the ' +
        'project root, or export it, then run again.',
    );
  }

  if (name === 'elevenlabs') {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('DEMO_TTS=elevenlabs but ELEVENLABS_API_KEY is not set');
    const voice = voiceOverride || DEFAULT_VOICE;
    const model = opts.model ?? 'eleven_multilingual_v2';
    const settings = {
      stability: opts.stability ?? 0.5,
      similarity_boost: opts.similarity ?? 0.75,
      style: opts.style ?? 0,
      use_speaker_boost: opts.speakerBoost ?? true,
    };

    return {
      name,
      voice,
      signature: `${name}|${voice}|${model}|${JSON.stringify(settings)}`,
      async render(text) {
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
          {
            method: 'POST',
            headers: { 'xi-api-key': key, 'content-type': 'application/json' },
            body: JSON.stringify({ text, model_id: model, voice_settings: settings }),
          },
        );
        if (!res.ok) {
          const body = (await res.text()).slice(0, 300);
          throw new Error(
            `ElevenLabs ${res.status}: ${body}` +
              (res.status === 401
                ? '\n(401 usually means the key lacks the text_to_speech permission.)'
                : res.status === 402
                  ? '\n(402 means the key is valid but the plan disallows this voice — ' +
                    'the free tier cannot use library voices through the API.)'
                  : ''),
          );
        }
        return Buffer.from(await res.arrayBuffer());
      },
    };
  }

  if (name === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('DEMO_TTS=openai but OPENAI_API_KEY is not set');
    const voice = voiceOverride || 'alloy';
    const model = opts.model ?? 'gpt-4o-mini-tts';
    return {
      name,
      voice,
      signature: `${name}|${voice}|${model}`,
      async render(text) {
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, voice, input: text }),
        });
        if (!res.ok) {
          throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        return Buffer.from(await res.arrayBuffer());
      },
    };
  }

  throw new Error(`unknown text-to-speech provider "${name}" (use elevenlabs or openai)`);
}

// ---- where the line actually starts ----
//
// Text to speech does not start on the word. It starts on a breath: 100-160 ms
// at -50 to -85 dB before the voice arrives, on any line that does not open
// with a vowel or a plosive. Placed at its file start, a line therefore begins
// with something barely audible and only then speaks — heard as the narration
// fading up. It survives loudness normalisation too, because normalising a
// breath just gives you a louder breath.
//
// So the head is measured and removed and the line is cued on its first word.
// Measured, not gated: `silenceremove` decides on peaks, and a -55 dB breath
// carries brief peaks above a -45 dB gate, which is exactly the case that
// matters here. RMS in 20 ms windows sees it for what it is.
const ONSET_DB = Number(process.env.TTS_ONSET_DB ?? -34);
const ONSET_KEEP_MS = 40; // left in front so the first consonant is not clipped
const ONSET_MAX_MS = 400; // never trim more than this, whatever the measurement says

function headSilenceMs(file) {
  const res = spawnSync(
    FFMPEG,
    [
      '-hide_banner', '-nostats',
      '-t', '1.5',
      '-i', file,
      '-af',
      'aresample=8000,asetnsamples=160,astats=metadata=1:reset=1,' +
        'ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f', 'null', '-',
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) return 0;

  const levels = [];
  for (const line of (res.stdout ?? '').split(/\r?\n/)) {
    const m = /RMS_level=(-?[\d.]+|-?inf)/.exec(line);
    if (m) levels.push(m[1].includes('inf') ? -91 : Number(m[1]));
  }

  const first = levels.findIndex((v) => v > ONSET_DB);
  if (first <= 0) return 0; // already starts on the word, or nothing loud enough
  return Math.max(0, Math.min(first * 20 - ONSET_KEEP_MS, ONSET_MAX_MS));
}

// Derived from the cached render, never in place of it: the .mp3 stays exactly
// as the provider returned it, so changing ONSET_DB re-derives from disk and
// re-bills nothing.
function trimHead(file) {
  const trimmed = file.replace(/\.mp3$/, '.lead.mp3');
  if (fs.existsSync(trimmed) && fs.statSync(trimmed).mtimeMs >= fs.statSync(file).mtimeMs) {
    return trimmed;
  }

  const ms = headSilenceMs(file);
  if (ms <= 0) return file;

  const res = spawnSync(
    FFMPEG,
    ['-y', '-v', 'error', '-ss', (ms / 1000).toFixed(3), '-i', file,
      '-c:a', 'libmp3lame', '-q:a', '2', trimmed],
    { encoding: 'utf8' },
  );
  if (res.status !== 0 || !fs.existsSync(trimmed)) return file;
  return trimmed;
}

/** Render one line, cached. Returns { file, cached, trimmedMs, duration }. */
export async function speak(provider, text, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });

  const hash = crypto
    .createHash('sha256')
    .update(`${provider.signature}|${text}`)
    .digest('hex')
    .slice(0, 16);

  const raw = path.join(cacheDir, `${hash}.mp3`);
  const cached = fs.existsSync(raw);
  if (!cached) fs.writeFileSync(raw, await provider.render(text));

  const file = trimHead(raw);
  const trimmedMs = file === raw ? 0 : Math.round((durationOf(raw) - durationOf(file)) * 1000);

  return { file, cached, trimmedMs, duration: durationOf(file) };
}
