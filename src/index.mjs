#!/usr/bin/env node
// videoedit — drop a take in, get a finished lesson out.
//
//   npm start                    process everything waiting in in/
//   npm start -- --watch         keep watching in/ and process what arrives
//   npm start -- "path/My Lesson Source.mp4"
//
// A take is any video in the inbox whose name ends "… Source". It becomes
// "… Output.mp4" in the outbox, and that pairing is the whole bookkeeping: a
// take that already has an output is considered done, so re-running is safe and
// picks up only what is new.

import fs from 'node:fs';
import path from 'node:path';

import { loadEnv } from './lib/env.mjs';
import {
  INBOX, OUTBOX, ROOT, WORK, ensureDirs, pendingTakes, stemOf, isTake,
} from './lib/paths.mjs';
import { processTake } from './run.mjs';

// A missing file, or an ffmpeg that is not installed, is an ordinary thing to
// get wrong and a V8 stack trace is not the answer to either. The messages
// thrown from here down are written to be read.
const die = (err) => {
  console.error(`\nvideoedit: ${err?.message ?? err}`);
  process.exit(1);
};
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

// ---- arguments ----
const argv = process.argv.slice(2);
const overrides = {};
const inputs = [];
let output = null;
let configPath = null;
let keepWork = false;
let analyzeOnly = false;
let watch = false;
let force = false;

const set = (key, value) => {
  const parts = key.split('.');
  const leaf = parts.pop();
  let node = overrides;
  for (const p of parts) node = node[p] ??= {};
  node[leaf] = value;
};

function usage() {
  console.log(`
videoedit — branded lessons from raw screen recordings

  npm start                        process every new take in ${path.relative(ROOT, INBOX)}/
  npm start -- --watch             keep watching for new takes
  npm start -- <take.mp4>          process one file

  -o, --out <file>       output path (default: "<name> Output.mp4" in ${path.relative(ROOT, OUTBOX)}/)
  -c, --config <file>    JSON overrides (default: <take>.json beside the take)
      --watch            stay running and process takes as they appear
      --force            re-process takes that already have an output

  copy
      --badge <text>     pill above the headline, --no-badge for none
      --title <text>     headline on the title card
      --highlight a,b    comma-separated phrases set in the brand blue
      --intro <text>     word after the logo in the opening ("academy")
      --no-intro-word    logo alone, no word after it

  stages
      --narrate          replace the narration with text to speech
      --voice <id>       ElevenLabs voice ID (default: DEMO_TTS_VOICE)
      --no-lists         skip transcription; no list sections
      --no-zoom          leave the recording at one scale throughout
      --no-tighten       keep every pause at its original length
      --no-blank-hold    show blank screens instead of holding the last frame
      --no-sfx           no transition cues
      --no-music         no bed
      --music <file>     use this bed instead of the brand's
      --no-denoise       leave the room tone in

  output
      --crf <n>          x264 quality, lower is bigger (default 18)
      --preset <name>    x264 speed/size tradeoff (default medium)
      --analyze-only     write the edit it would make and stop
      --keep-work        leave the intermediates in ${path.relative(ROOT, WORK)}/
`);
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o' || a === '--out') output = argv[++i];
  else if (a === '-c' || a === '--config') configPath = argv[++i];
  else if (a === '--watch') watch = true;
  else if (a === '--force') force = true;
  else if (a === '--badge') set('copy.badge', argv[++i]);
  else if (a === '--title') set('copy.headline', argv[++i]);
  else if (a === '--highlight') set('copy.highlight', argv[++i].split(',').map((s) => s.trim()));
  else if (a === '--no-badge') set('copy.badge', null);
  else if (a === '--intro') set('copy.introWord', argv[++i]);
  else if (a === '--no-intro-word') set('copy.introWord', '');
  else if (a === '--narrate') set('narration.replace', true);
  else if (a === '--no-narrate') set('narration.replace', false);
  else if (a === '--voice') set('narration.voice', argv[++i]);
  else if (a === '--no-lists') set('list.auto', false);
  else if (a === '--no-zoom') set('zoom.enabled', false);
  else if (a === '--no-tighten') set('tighten.enabled', false);
  else if (a === '--no-blank-hold') set('frame.holdBlanks', false);
  else if (a === '--no-sfx') set('audio.sfx', false);
  else if (a === '--no-music') set('audio.music', false);
  else if (a === '--music') set('audio.musicFile', argv[++i]);
  else if (a === '--no-denoise') { set('audio.denoise', false); set('audio.duck', false); }
  else if (a === '--crf') set('encode.crf', Number(argv[++i]));
  else if (a === '--preset') set('encode.preset', argv[++i]);
  else if (a === '--keep-work') keepWork = true;
  else if (a === '--analyze-only') analyzeOnly = true;
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else if (a.startsWith('-')) { console.error(`unknown option "${a}"`); usage(); process.exit(1); }
  else inputs.push(a);
}

loadEnv();
ensureDirs();

const common = { output, configPath, overrides, keepWork, analyzeOnly };

async function runOne(file, index = 1, total = 1) {
  const label = total > 1 ? `[${index}/${total}] ` : '';
  console.log(`\n${'-'.repeat(70)}\n${label}${stemOf(file)}\n${'-'.repeat(70)}`);
  const t0 = Date.now();
  try {
    const result = await processTake({ ...common, input: file });
    if (result) console.log(`\ndone in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    return true;
  } catch (err) {
    // One bad take should not stop a batch, and it should not be silent either.
    console.error(`\nFAILED: ${stemOf(file)}\n  ${err?.message ?? err}`);
    return false;
  }
}

async function runBatch(files) {
  let ok = 0;
  for (const [i, file] of files.entries()) {
    if (await runOne(file, i + 1, files.length)) ok++;
  }
  if (files.length > 1) console.log(`\n${ok} of ${files.length} finished.`);
  return ok;
}

// ---- explicit files win over the inbox ----
if (inputs.length) {
  const ok = await runBatch(inputs.map((f) => path.resolve(f)));
  process.exit(ok === inputs.length ? 0 : 1);
}

// ---- the inbox ----
const waiting = pendingTakes({ force });

if (!waiting.length && !watch) {
  const any = fs.existsSync(INBOX) && fs.readdirSync(INBOX).some(isTake);
  console.log(
    any
      ? `Nothing to do — every take in ${path.relative(ROOT, INBOX)}/ already has an output.\n` +
        'Use --force to re-process, or --watch to wait for new ones.'
      : `Nothing in ${path.relative(ROOT, INBOX)}/ yet.\n` +
        'Drop a recording named "<Lesson name> Source.mp4" there and run again, ' +
        'or use --watch.',
  );
  process.exit(0);
}

// A take that failed has to reach the caller as a non-zero status, or
// `rules.strict` cannot do its job: an unattended batch that stops before the
// encode and then reports success is no better than one that never checked.
// Not under --watch, where the process is meant to stay up and try again.
let failed = 0;
if (waiting.length) failed = waiting.length - (await runBatch(waiting));
if (failed && !watch) process.exit(1);

// ---- watch ----
if (watch) {
  const where = path.relative(ROOT, INBOX);
  console.log(`\nWatching ${where}/ — drop a "… Source.mp4" in to process it. Ctrl-C to stop.`);

  const seen = new Set();
  let busy = false;

  // A file still being copied in is not ready to read. Waiting for its size to
  // stop changing is cruder than a lock, but it works with every way a file can
  // arrive: a copy, a download, a sync client, a network share.
  async function settled(file) {
    let last = -1;
    for (let i = 0; i < 60; i++) {
      const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
      if (size > 0 && size === last) return true;
      last = size;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  async function sweep() {
    if (busy) return;
    busy = true;
    try {
      for (const file of pendingTakes({ force: false })) {
        if (seen.has(file)) continue;
        if (!(await settled(file))) {
          console.log(`still arriving, will retry: ${path.basename(file)}`);
          continue;
        }
        seen.add(file);
        await runOne(file);
        console.log(`\nWatching ${where}/ ...`);
      }
    } finally {
      busy = false;
    }
  }

  fs.watch(INBOX, () => { sweep(); });
  setInterval(sweep, 10000);
  await new Promise(() => {}); // until interrupted
}
