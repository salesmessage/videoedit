// The look, in numbers.
//
// Everything here was measured off the two hand-finished lessons in
// reference/ — the mat inset, where the title sits, how long the logo
// takes to build. They are defaults, not laws: a per-video JSON sidecar
// (see resolveConfig) overrides any of them by the same key path.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  // ---- canvas ----
  width: 1920,
  height: 1080,
  fps: 30,

  // ---- the mat the recording sits on ----
  // Measured off "[T1] 4.2 — Managing conversations in your inbox", whose take
  // is 1894x1080 — near enough the same shape as anything else coming out of
  // this recording setup. Its card sits at 197..1717 x 105..974, so: 200px of
  // mat at the sides, 105 top and bottom, corners on a 50px radius.
  //
  // The other example frames tighter (144px sides) and there is no rule that
  // produces both, so this is a choice rather than a derivation: the wider mat
  // is the one that matches a source of these proportions.
  frame: {
    paddingX: 200,
    minPaddingY: 105,
    radius: 50,
    // The recording does not run to the rounded edge. In the example it is
    // inset about 12px, and that inset reads as a pale ring round the whole
    // card — measured off 4.2 at the top edge (mat to y105, ring y106-118,
    // screenshot from y119) and the same on the left. Without it the card
    // looks flat and the screenshot looks like it is bleeding off.
    border: 12,
    borderColor: '#e4e6ea',
    // Fitted against the example's own falloff — the mat reads 21% darker
    // where it meets the card and is back to its own colour ~80px out.
    shadowColor: '#143c64',
    shadowBlur: 70,
    shadowOffsetY: 26,
    shadowAlpha: 0.45,
    // A page that has not painted yet — a blank white tab, or the dark plum a
    // Salesforce page shows while it loads — is dead screen time the viewer
    // reads as a fault. Those frames are dropped and the last frame that had
    // something on it is held instead. Detail is the standard deviation of the
    // sampled frame: blanks measure ~0.6 here and the quietest real screen 14.8,
    // so there is a wide gap to sit in.
    holdBlanks: true,
    blankDetail: 12,
    blankMin: 0.3,
    // Black bars baked into the take, trimmed before anything measures it.
    // See stages/letterbox.mjs for why this cannot be left to the matting.
    letterbox: {
      trim: true,
      crop: null, // {x,y,w,h} to force it; null to detect
      limit: 24, // how dark counts as black, 0-255
      samples: 9, // frames spread through the take; all must agree
      min: 8, // total pixels dropped below which it is not worth an encode
      crf: 16, // one generation before the real encode, so keep it cheap
      preset: 'veryfast',
    },
    // The recording slides in from the right over the title card and settles.
    slideIn: 0.45,
    settleScale: 1.035,
    settle: 0.9,
  },

  // ---- animated mesh background ----
  // Sampled off the examples: a near-white field with soft blue blooms
  // drifting through it, never darker than roughly #c1d6f8.
  background: {
    base: 0.9, // how far the field is tinted toward white
    blobs: [
      { tint: 0.68, r: 0.62, cx: 0.18, cy: 0.28, ax: 0.1, ay: 0.07, hz: 0.031, phase: 0.0 },
      { tint: 0.74, r: 0.55, cx: 0.82, cy: 0.72, ax: 0.11, ay: 0.09, hz: 0.024, phase: 1.9 },
      { tint: 0.6, r: 0.48, cx: 0.55, cy: 0.95, ax: 0.13, ay: 0.06, hz: 0.037, phase: 3.4 },
      { tint: 1.0, r: 0.5, cx: 0.72, cy: 0.22, ax: 0.12, ay: 0.1, hz: 0.028, phase: 5.1 },
      { tint: 1.0, r: 0.42, cx: 0.3, cy: 0.78, ax: 0.09, ay: 0.08, hz: 0.033, phase: 2.5 },
    ],
  },

  // ---- opening ----
  // Timings measured frame by frame off example 1.3: the mark is alone until
  // 1.50s, the wordmark's letters arrive from 1.55 one every 0.05s, "academy"
  // starts at 2.05, and everything has settled by 2.65. The lockup geometry is
  // measured off the same frame at 3.5s — logo 524px wide, a 7px rule 45px
  // after it, "academy" 46px after that at 385px wide.
  intro: {
    hold: 0.35, // empty field before the mark appears
    markIn: 0.7, // mark springs up to full size
    markSettle: 0.45, // and shrinks from oversize to lockup size
    build: 1.15, // letters arrive and the tracking collapses
    glyphStagger: 0.045,
    glyphIn: 0.25,
    wordAt: 0.55, // into the build
    // The tracking multiplier the letters start on, and the time constant both
    // it and the mark's travel decay with. Fitted to the example: the spread
    // measures 2.1x at 1.55s, 1.45x at 1.75s, 1.18x at 2.05s and 1.0 by 2.65s.
    spread: 2.31,
    settleTau: 0.243,
    rest: 2.2, // the finished lockup holds
    out: 0.45, // and dissolves into the title card
    lockupHeight: 105,
    markOversize: 1.35,
    dividerGap: 45,
    dividerWidth: 7,
    dividerHeight: 0.733,
    wordGap: 46,
    // The word after the rule is copy, not a constant: `copy.introWord` sets it
    // per video and an empty string leaves the logo standing alone.
    //
    // Inter Regular at 94px matches the example's glyph widths exactly
    // ([42,45,42,46,46,68,48] against its [42,45,42,46,47,69,47]); the -2px
    // tracking is what brings the total from 399 to its 385.
    wordSize: 0.895,
    wordWeight: 400,
    wordTracking: -2,
    wordBaseline: 0.78,
    wordColor: '#43454f',
  },

  // ---- title card ----
  title: {
    // Measured off the example's title card once it has settled — the block
    // starts at x262 and the headline runs to x1578, so the margins are
    // symmetric and the text has 1396px to wrap in. It drifts right and shrinks
    // from about 7.4s as the recording slides in over it, so the reading has to
    // be taken before that or it comes out ~60px too far in.
    marginX: 262,
    pillHeight: 105,
    // Not a stadium. Fitting the example's corner profile gives a radius of 29
    // against the 53 a half-height cap would produce, and the difference is
    // plain once you look for it: the badge is a rounded rectangle.
    pillRadius: 29,
    pillPadX: 38, // measured: text ink starts 38px inside the pill, both ends
    // The example's badge sets "Module 4: Sending and Receiving Texts" 878px
    // wide where Inter Bold at 44px sets it 846 — 32px spread over its five
    // spaces. So the wide word-space is the example's, not an invention, and it
    // also fixes the case that first drew attention to it: without it "T1 1.2"
    // reads as "T11.2", the two 1s landing 9px apart inside a numeric badge.
    pillWordSpacing: 7,
    pillFontSize: 44, // cap height 32px in the example, and Inter's cap is 0.727em
    pillWeight: 700,
    // Pill bottom to the headline's cap top measures 68 in the example, but
    // the baseline the renderer derives sits ~10px below the cap, so the
    // constant that produces 68 on screen is 57.
    pillGap: 57,
    // The example's block is not quite centred: it sits 14px above where
    // centring the pill-plus-leading height would put it. Carried as a nudge
    // rather than folded into the gap, so the two stay independently checkable.
    blockNudge: -14,
    // The example's headline is not any cut in brand/fonts: its cap height is
    // 94px where Neue Einstellung Bold at that width would be 89, and its 'M'
    // is 91px wide where the same face at cap 94 draws 103. Every glyph is
    // about 12% narrow — a condensed cut we do not have, or the type squeezed
    // in the editor. Reproducing it as a squeeze puts all four measurements
    // within 1%: line one 1306 against 1307, cap 94 exactly.
    headlineSize: 134,
    headlineScaleX: 0.87,
    headlineLeading: 123, // baseline to baseline, measured 589 -> 712
    headlineWeight: 700,
    ink: '#16181d',
    maxLines: 3,
    // animation
    pillGrow: 0.42,
    pillTextIn: 0.3,
    wordStagger: 0.075,
    wordIn: 0.34,
    hold: 1.5,
  },

  // ---- list sections ----
  // When the narrator enumerates — "there's freemium, premium and sandbox" —
  // the examples stop treating the recording as the whole picture: it slides
  // right and shrinks to a window, and the points appear beside it as a
  // checklist under a headline.
  //
  // Every number here is measured off that sequence in example 4.2
  // (28s-48s): logo at 81,135 at 88px tall; headline baseline 405; items on
  // an 81.5px rhythm from 534, each a 47px blue check followed by text at 162.
  list: {
    auto: true, // draft sections from the narration (see lists.mjs)
    model: 'ggml-base.en.bin', // in models/; see the README
    marginX: 81,
    logoTop: 135,
    logoHeight: 88,
    headlineTop: 340,
    headlineSize: 90,
    headlineWeight: 700,
    itemsTop: 534,
    itemStride: 81.5,
    itemSize: 40,
    itemWeight: 600,
    boxSize: 47,
    boxRadius: 12,
    boxGap: 34,
    ink: '#16181d',
    // The window the recording shrinks into, right of the copy.
    window: { x: 982, y: 105, w: 857, h: 869 },
    // Timing, in seconds.
    move: 0.7, // the recording travelling to its smaller window
    logoIn: 0.4,
    headlineIn: 0.5,
    itemsStart: 1.0, // the first point waits for the headline to finish
    itemStagger: 0.85, // then they land one at a time, roughly on the beat
    itemIn: 0.45,
    out: 0.6,
    minHold: 4,
  },

  // ---- closing ----
  outro: {
    in: 0.6,
    hold: 2.2,
    out: 0.5,
    // The closing lockup is not the opening one held: the example settles it
    // about a tenth larger — 1100x116 against the opening's 1010x105, measured
    // once both have stopped moving. It reads as the mark stepping forward to
    // sign off rather than the intro playing again.
    lockupScale: 1.095,
  },

  // ---- dead-air tightening ----
  // A pause between two spoken sentences is not dead air, it is the beat the
  // viewer reads the screen in. Only a run that is both silent and frozen for
  // longer than `min` counts, and even then it is squeezed rather than excised.
  tighten: {
    enabled: true,
    min: 1.6, // shortest dead run worth acting on, seconds
    keep: 0.6, // screen time left where a dead run was
    speed: 4, // ceiling on how fast a dead run may be played
    head: 0.6, // silence kept before the first thing that happens
    tail: 1.8, // screen time kept after the last thing that happens
    // What counts as the picture standing still, as a fraction of the total
    // possible frame-to-frame change. Not zero: a caret blinking in a field, a
    // chat bubble breathing in the corner and a spinner going round are all
    // "nothing is happening" as far as an edit is concerned.
    stillEnergy: 0.0002,
  },

  // ---- automatic zoom ----
  // There is no cursor telemetry for a recording that arrives as a finished
  // mp4, so the zoom follows what moves. Where the change between frames is
  // small and tightly clustered — a menu opening, a field being typed into —
  // that is the thing worth looking at. Where it is spread across the frame —
  // a scroll, a page navigation — zooming would only fight the content.
  // A zoom in the examples is a passage, not a reaction. 4.2 pushes in at 28s
  // and stays in until 48 — twenty seconds at 1.16, with a couple of deeper
  // looks inside it — then again for seven seconds at 122. About a fifth of its
  // body is zoomed, across two moves. The numbers here are set to reproduce
  // that shape rather than to chase individual bursts of movement.
  zoom: {
    enabled: true,
    depth: 1.2, // scale at full zoom; the example sustains 1.16
    minHold: 1.6, // shortest region worth zooming for
    maxHold: 20, // the example's longest hold, and a natural ceiling
    // Ceiling on how much of the body may be zoomed at all. Qualifying is
    // not the same as deserving: a busy lesson offers far more than it
    // should use, and the example spends about a fifth. See zoomPlan.
    maxCoverage: 0.25,
    // Long enough to carry across the pauses inside one passage. This is the
    // parameter that decides whether a zoom is a reaction or a passage, and the
    // example is unambiguous that it should be a passage: at 1.2s this take got
    // three twitches over 11% of its body, at 5s it gets two holds over 18%
    // (the example: two, 19%), and at 8s the whole lesson became one zoom.
    gap: 5,
    ramp: 0.55, // ease in / out
    panMs: 650,
    maxSpread: 0.28, // activity wider than this (frame fraction) is not zoomable
    // A floor, not the threshold — the working gate is the median energy of the
    // frames that moved, computed per take. See zoomPlan.
    minActivity: 1e-5,
    activityPercentile: 0.5,
    sampleFps: 10,
    sampleWidth: 192,
  },

  // ---- narration replacement ----
  // Off by default, and deliberately so: it bills a third-party API and it
  // throws away the performance the take was recorded with. `--narrate` turns
  // it on for one run; `"narration": { "replace": true }` in the sidecar makes
  // it the rule for one lesson.
  //
  // The voice and the key come from .env at the project root (ELEVENLABS_API_KEY,
  // DEMO_TTS_VOICE). Clips are cached under work/tts by provider + voice +
  // settings + text, so re-rendering a lesson after changing anything else
  // costs nothing and re-bills nothing.
  narration: {
    replace: false,
    provider: null, // null = from DEMO_TTS, else whichever key is set
    voice: null, // null = from DEMO_TTS_VOICE, else the provider default
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarity: 0.75,
    style: 0,
    speakerBoost: true,
    // Placement. A line is anchored to where the original started and may only
    // be delayed, never brought forward: the picture cuts to whatever the line
    // is about, and a line that arrives early describes something not yet on
    // screen.
    // How long the recording runs on after the last line. The closing line has
    // to meet the outro rather than finish and leave the screen sitting there:
    // with the outro dissolving in over its last 0.6s, this puts the card up
    // just as the voice stops.
    tail: 0.9,
    gap: 0.22, // silence left between one line and the next
    maxTempo: 1.15, // past this a compressed line sounds hurried
    premixLufs: -20, // every clip put on this level before the mix
    maxGainDb: 6, // never trust one measurement enough to swing further
    // Words whisper got wrong, corrected before the line is spoken. Empty by
    // default because the right entries are per-take: they depend on what this
    // narrator said and what the transcriber made of it. Matching is
    // case-insensitive and word-bounded — see applyFixes in stages/narrate.mjs.
    fixes: {},
  },

  // ---- audio ----
  audio: {
    // Room tone, fan noise and mic hiss, taken out before anything amplifies
    // them. Order matters: highpass first for rumble, then the spectral
    // denoiser, and only then the levellers — run the other way round,
    // speechnorm lifts the noise floor between words into an audible pump and
    // the denoiser has to chase a moving target.
    //
    // `nr` is 14 dB rather than the 30 or 40 the filter allows. Denoising is
    // a trade against the voice, and past about 15 dB an ordinary screen-
    // recording mic starts to sound underwater — which is a worse fault than
    // the hiss it removes.
    // Room tone and mouse clicks, taken out before anything amplifies them.
    // The high-pass is steeper and higher than the usual 80 Hz because the
    // rumble is where most of this library's noise energy lives.
    denoise: true,
    denoiseDb: 18,
    // 75 Hz, not the 110 I first used: this narrator's fundamental has a
    // median of 111 Hz and a fifth percentile of 73, so a 110 Hz corner cuts
    // straight through the voice and thins it. Everything below 75 is room.
    highpass: 75,
    highpassPoles: 2,
    // The noise floor handed to the denoiser is measured per take (see
    // analyze.mjs) rather than assumed; this is only the fallback.
    noiseFloorDb: -50,
    filter: 'speechnorm=e=6.25:r=0.0005:l=1',
    // Ducking the measured silences is what actually removes the background
    // noise: -14 dB in the gaps, and by construction it cannot reach speech.
    // Measured on the take this was built against: the level where nobody is
    // speaking drops from -27 to -42 dBFS while the variation between spoken
    // phrases stays at 4.5 dB, which is where the hand-finished examples sit.
    duck: true,
    duckDb: 20,
    duckRamp: 0.1,
    duckMin: 0.25, // shortest silence worth ducking
    duckPad: 0.05, // shrink each span so a ramp never lands on a word
    duckMaxSpans: 400,
    loudness: { I: -16, TP: -1.5, LRA: 11 },
    // Transition cues, lifted from the examples (brand/sfx). They are the
    // brand's own sounds, so they are on by default.
    sfx: true,
    sfxDb: -3,
    // The bed. The examples DO have one — a very quiet sustained pad under the
    // body only, which is why their room tone is inaudible: it is masked. It
    // shows up as steady tones ~13 dB above the take's own floor at 233 Hz and
    // ~49 Hz, moving between notes across the lesson, and it is absent from the
    // opening and the outro, both of which are digital silence.
    //
    // The track itself cannot be recovered from a finished mix, so drop it in
    // brand/music and it is placed at this level automatically.
    // -34 LUFS puts the bed where the example's sits: about 17 dB under the
    // narration, and roughly -36 dBFS in the gaps, which is what 4.2 measures.
    music: true,
    musicTargetDb: -34,
    // 0 disables side-chaining. The examples hold a steady pad rather than
    // ducking it — at this level there is nothing to make room for, and a
    // compressor keyed to the voice only makes the bed breathe.
    musicDuckDb: 0,
    musicFade: 1.2,
    fadeIn: 0.4,
    fadeOut: 1.2,
  },

  // Words a headline must not lower-case when it is derived from a file name.
  // Product names arrive title-cased and have to stay that way; everything
  // else in a lesson title does not.
  properNouns: [
    'Salesmsg', 'SalesMessage', 'Salesforce', 'HubSpot', 'Zapier', 'Slack', 'Twilio',
    'Google', 'Gmail', 'Outlook', 'Zoom', 'Stripe', 'Shopify', 'Pipedrive', 'Zoho',
    'ActiveCampaign', 'Keap', 'Chrome', 'Academy', 'AI', 'API', 'SMS', 'MMS', 'CRM',
    'RCS', 'CSV', 'URL', 'A2P', '10DLC',
  ],

  // ---- encode ----
  encode: {
    crf: 18,
    preset: 'medium',
    audioBitrate: '192k',
    // Canvas resampling for the recording. 'high' is indistinguishable from
    // 'medium' at the scale factors this pipeline uses and costs about three
    // times as much; raise it only if a source is being scaled hard.
    scaleQuality: 'medium',
  },

  // ---- house rules ----
  // Not numbers describing the look but conditions on the edit — see
  // lib/rules.mjs, which holds each rule's reasoning and its remedy. They are
  // checked at plan time and their verdicts are written into the plan report.
  rules: {
    // Every lesson carries at least one list section, hand-written when
    // detection drafts none.
    requireSection: true,
    // Report each section's crop anchor so a computed one gets looked at.
    declareFocus: true,
    // Off: a broken rule warns. On: it stops the run before the encode.
    strict: false,
  },
};

function isPlain(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isPlain(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlain(base?.[k]) && isPlain(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * Title copy, when the sidecar does not supply it.
 *
 * The file names in this library read "[T1] 4.2 — Managing conversations in
 * your inbox Source.mp4": a module tag, a lesson number, the lesson title, and
 * the word "Source" marking it as the raw take. All three parts are worth
 * keeping, so they are pulled apart rather than dropped.
 *
 * The badge is the part the file name cannot really supply. The hand-finished
 * 4.2 badges it "Module 4: Sending and Receiving Texts" — what the module is
 * about, not where it sits in the tree — and no derivation gets that from
 * "[T1] 4.2". So "Module 4" is the most this can honestly produce, and it is
 * offered as a starting point for the sidecar to replace rather than as the
 * finished thing.
 */
export function copyFromFilename(file, properNouns = DEFAULTS.properNouns) {
  let stem = path.basename(file).replace(/\.[^.]+$/, '');
  stem = stem.replace(/[\s_-]*\b(source|raw|take|screen ?rec(ording)?)\b[\s_-]*$/i, '').trim();

  const tag = /^\s*\[([^\]]+)\]\s*/.exec(stem);
  if (tag) stem = stem.slice(tag[0].length);

  // The leading number is the module, and its first component is the part the
  // badge wants: "4.2" is lesson 2 of module 4.
  let badge = null;
  const num = /^\s*(\d+)(?:\.\d+)*\s*[—–-]?\s*/.exec(stem);
  if (num) {
    badge = `Module ${num[1]}`;
    stem = stem.slice(num[0].length);
  }

  stem = stem.replace(/^[\s—–-]+/, '').trim();

  // Sentence case. The examples set headlines in sentence case, while file
  // names arrive in Title Case — but lower-casing indiscriminately turns
  // "Salesforce" into "salesforce", so anything that is shouting, internally
  // capitalised, or on the proper-noun list is left alone.
  const keep = new Map(properNouns.map((w) => [w.toLowerCase().replace(/[^a-z0-9]/g, ''), w]));
  const headline = stem
    .split(/(\s+)/)
    .map((w, i) => {
      if (i === 0 || /^\s+$/.test(w)) return w;
      const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (keep.has(bare)) return w.replace(/[A-Za-z0-9]+/, keep.get(bare));
      if (/^[A-Z0-9&/]{2,}[^a-z]*$/.test(w)) return w; // SMS, CRM, 10DLC
      if (/^[A-Z][a-z]*[A-Z]/.test(w)) return w; // HubSpot, SalesMessage
      return w[0].toLowerCase() + w.slice(1);
    })
    .join('');

  return { badge, headline: headline || path.basename(file, path.extname(file)) };
}

/** DEFAULTS <- preset (if named) <- sidecar JSON <- CLI overrides. */
export function resolveConfig({ input, configPath, overrides = {} }) {
  let cfg = DEFAULTS;

  const sidecars = [];
  if (configPath) sidecars.push(path.resolve(configPath));
  else {
    const stem = input.replace(/\.[^.]+$/, '');
    sidecars.push(`${stem}.json`, path.join(path.dirname(input), 'video.json'));
  }

  let used = null;
  for (const p of sidecars) {
    if (!fs.existsSync(p)) continue;
    const json = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
    cfg = deepMerge(cfg, json);
    used = p;
    break;
  }

  cfg = deepMerge(cfg, overrides);

  const auto = copyFromFilename(input, cfg.properNouns);
  cfg.copy = deepMerge(
    { badge: auto.badge, headline: auto.headline, highlight: [], introWord: 'academy' },
    cfg.copy ?? {},
  );

  return { config: cfg, sidecar: used };
}
