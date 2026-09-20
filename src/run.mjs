// One take, all the way through.
//
// The stages, in order, and what each decides:
//
//   analyse   where the narration is, where the picture is still, where it is
//             changing, what is being said
//   narrate   optionally re-voice the take, keeping every line on its own mark
//   plan      which stretches survive and at what speed; where to zoom; where a
//             list card belongs
//   tighten   cut picture and sound together in one filtergraph, so they cannot
//             drift apart
//   render    one frame loop: opening, title card, matted recording, list
//             sections, outro
//   sound     clean, level, place the cues and the bed, mux
//
// Everything the look depends on lives in lib/config.mjs and can be overridden
// per video by a JSON file beside the take.

import fs from 'node:fs';
import path from 'node:path';

import { probe, durationOf } from './lib/ffmpeg.mjs';
import { resolveConfig } from './lib/config.mjs';
import {
  readStyleGuide, registerBrandFonts, resolveFont, loadArt, BRAND_DIR,
} from './lib/brand.mjs';
import { ROOT, WORK, CACHE, MODELS, brandFile, outputFor, slug } from './lib/paths.mjs';
import { audioTrack, motionTrack, intersect, transcribe } from './stages/analyse.mjs';
import { pickProvider } from './lib/tts.mjs';
import { narrate } from './stages/narrate.mjs';
import { detectSections, mergeSections } from './lib/lists.mjs';
import { cutPlan, timeMapper, zoomPlan, zoomTrack } from './stages/plan.mjs';
import { reportRules } from './lib/rules.mjs';
import { trimLetterbox } from './stages/letterbox.mjs';
import { applyCuts } from './stages/tighten.mjs';
import { render, buildTimeline } from './stages/render.mjs';
import {
  buildAudio, muxSilent, findMusic, verify, cuesFor, cleanChain, measureLoudness, musicGain,
} from './stages/sound.mjs';

/**
 * Process one take. Returns the finished file, or null when `analyzeOnly`
 * stopped it after writing the plan.
 */
export async function processTake({
  input,
  output = null,
  configPath = null,
  overrides = {},
  keepWork = false,
  analyzeOnly = false,
} = {}) {
  input = path.resolve(input);
  if (!fs.existsSync(input)) throw new Error(`no such file: ${input}`);

  // Everything named after the take is named after the take as it arrived —
  // `input` is swapped for an intermediate below once the black bars come off,
  // and a transcript called "cropped" would collide between takes in a batch.
  const stem = path.basename(input, path.extname(input));

  // Defaults, then the preset, then a JSON sidecar beside the take, then
  // anything the command line said. Later wins.
  const { config, sidecar } = resolveConfig({ input, configPath, overrides });

  output = path.resolve(output ?? outputFor(input));
  const work = WORK;
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });

  // ---- brand ----
  const style = readStyleGuide();
  const loadedFonts = registerBrandFonts();
  const fonts = {
    headline: resolveFont(style.headlineFont, 'headline'),
    body: resolveFont(style.bodyFont, 'body'),
  };
  const art = await loadArt();
  const brand = { blue: style.blue, green: style.green };

  let source = probe(input);
  config.source = source;
  config.fps = config.fps || Math.round(source.fps);

  console.log(`in    : ${path.basename(input)}`);
  console.log(`        ${source.width}x${source.height} @ ${source.fps.toFixed(2)}fps, ` +
    `${source.duration.toFixed(1)}s, audio ${source.hasAudio ? 'yes' : 'none'}`);
  console.log(`brand : ${path.relative(ROOT, BRAND_DIR)} — ${loadedFonts.length} font file(s), ` +
    `${style.blue}`);
  console.log(`type  : ${fonts.headline} / ${fonts.body}`);
  if (sidecar) console.log(`config: ${path.relative(ROOT, sidecar)}`);
  console.log(`copy  : ${config.copy.badge ? `[${config.copy.badge}] ` : ''}${config.copy.headline}` +
    (config.copy.highlight?.length ? `  (blue: ${config.copy.highlight.join(', ')})` : ''));

  // ---- black bars ----
  // First, because every measurement after this one assumes the frame it is
  // handed is the picture.
  {
    const trimmed = trimLetterbox({
      input, work, source, config,
      onNote: (msg) => console.log(`crop  : ${msg}`),
    });
    input = trimmed.file;
    source = trimmed.source;
    config.source = source;
  }

  // ---- what is being said ----
  // The transcript serves two stages: the list sections, and — when narration is
  // being replaced — the script itself. It is the slowest step after rendering,
  // so it runs only when one of them needs it.
  const wantLists = config.list.auto && source.hasAudio;
  const wantNarration = config.narration.replace && source.hasAudio;

  let transcript = [];
  if (wantLists || wantNarration) {
    process.stdout.write('analyse: speech ... ');
    const t0 = Date.now();
    transcript = transcribe(input, {
      model: path.join(MODELS, config.list.model),
      // Filtergraph paths cannot contain commas, colons or quotes — the parser
      // reads them as its own syntax — and lesson file names contain all three.
      out: path.join(work, `${slug(stem)}.transcript.json`),
    });
    console.log(`${transcript.length} segment(s) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  // ---- narration ----
  // Replacing the voice happens before anything is measured, because it changes
  // where the speech is. Everything downstream then sees an ordinary take and
  // needs to know nothing about it.
  let take = input;
  let narration = null;

  if (wantNarration) {
    if (!transcript.length) throw new Error('nothing to narrate — the transcript came back empty');

    const provider = pickProvider(config.narration);
    const narrated = path.join(work, 'narrated.mkv');
    process.stdout.write(`narrate: ${provider.name} voice ${provider.voice} ... `);

    narration = await narrate({
      input,
      output: narrated,
      segments: transcript,
      provider,
      // Not under work/: that directory is intermediate output and gets cleared
      // between runs, and clearing it would re-bill every line.
      cacheDir: path.join(CACHE, 'tts'),
      opts: config.narration,
      onProgress: (n, total) => process.stdout.write(`\rnarrate: ${provider.name} voice ${provider.voice} — line ${n}/${total}   `),
    });

    process.stdout.write('\r');
    console.log(
      `narrate: ${narration.lines.length} line(s), ${narration.billed} rendered ` +
      `(${narration.characters} chars), ${narration.fromCache} from cache` +
      (narration.debreathed ? `, ${narration.debreathed} de-breathed` : '') +
      (narration.corrected ? `, ${narration.corrected} corrected` : '') +
      (narration.dropped ? `, ${narration.dropped} dropped` : ''),
    );
    console.log(
      `         levels spanned ${narration.spread.toFixed(1)} LU -> ${config.narration.premixLufs} LUFS; ` +
      `${narration.compressed} line(s) compressed to fit, worst drift ` +
      `${narration.worstDrift.toFixed(2)}s`,
    );

    take = narration.file;

    // Synthesised speech has digital silence between lines and no room tone at
    // all, so the denoiser has nothing to remove and the gap duck nothing to
    // duck. Leaving them on would only risk chewing the new voice.
    config.audio = { ...config.audio, denoise: false, duck: false };
  }

  // ---- analyse ----
  process.stdout.write('analyse: sound ... ');
  const sound = source.hasAudio ? await audioTrack(take) : null;
  console.log(
    sound
      ? `floor ${sound.floorDb.toFixed(0)} dB, voice ${sound.peakDb.toFixed(0)} dB, ` +
        `gate ${sound.gateDb.toFixed(0)} dB — ${sound.speech.length} spoken stretch(es)`
      : 'no audio track',
  );

  process.stdout.write('analyse: picture ... ');
  const motion = await motionTrack(take, {
    ...config.zoom,
    stillEnergy: config.tighten.stillEnergy,
    blankDetail: config.frame.blankDetail,
    blankMin: config.frame.blankMin,
  });
  console.log(
    `${motion.samples.length} sample(s), ${motion.calm.length} calm ` +
    `(${motion.frozen.length} frozen) stretch(es), ` +
    `${motion.blank.length} blank (${motion.blank.reduce((n, [a, b]) => n + b - a, 0).toFixed(1)}s)`,
  );

  // A stretch is dead only when it is silent AND the picture is going nowhere. A
  // still screen under a narration line is not dead — it is the shot the line
  // plays over, and cutting it truncates the voice.
  //
  // Each dead run is tagged with whether it is frozen outright, which decides
  // whether it gets shortened or merely played fast.
  const speech = sound?.speech ?? [];
  const overlap = (run, list) =>
    list.reduce((s, [a, b]) => s + Math.max(0, Math.min(run[1], b) - Math.max(run[0], a)), 0);
  const dead = sound
    ? intersect(sound.silence, motion.calm)
        .filter(([a, b]) => b - a >= config.tighten.min)
        .map((run) => [...run, overlap(run, motion.frozen) / (run[1] - run[0]) > 0.75])
    : [];

  // ---- plan ----
  const takeDuration = take === input ? source.duration : durationOf(take);

  // With a synthesised voice the exact moment the last line ends is known, so the
  // recording is trimmed to just past it. Otherwise the closing line finishes and
  // the screen sits there for a few seconds before the outro arrives, which reads
  // as the video having forgotten to end.
  let planDuration = takeDuration;
  if (narration) {
    const last = narration.lines[narration.lines.length - 1];
    planDuration = Math.min(takeDuration, last.at + last.played + config.narration.tail);
    if (planDuration < takeDuration - 0.05) {
      console.log(
        `        closing line ends at ${(last.at + last.played).toFixed(1)}s — ` +
        `trimming ${(takeDuration - planDuration).toFixed(1)}s so the outro meets it`,
      );
    }
  }

  const cuts = cutPlan({ duration: planDuration, dead, speech, opts: config.tighten });
  const map = timeMapper(cuts.segments);
  const bodyDuration = map.total;

  // Sections are authored (or detected) against the raw take, because that is
  // what the person editing them is watching. Remap them onto the cut body here.
  const drafted = wantLists ? detectSections(transcript, { minHold: config.list.minHold }) : [];

  // Which horizontal slice of the recording survives the crop: wherever the
  // picture was busiest while the section is up. Left is only right when the
  // action happens to be on the left.
  const focusOf = (a, b) => {
    let w = 0;
    let x = 0;
    for (const s of motion.samples) {
      if (s.t < a || s.t > b || s.cx === undefined) continue;
      w += s.energy;
      x += s.cx * s.energy;
    }
    return w > 0 ? x / w : 0;
  };

  // Kept on the take's own clock as well as the body's. The renderer wants
  // body time, but the zoom planner reads the motion samples, which are indexed
  // against the source — handing it the mapped copy silently blanks the wrong
  // stretch as soon as anything upstream of a section is cut.
  const inSource = mergeSections(config.sections ?? [], drafted);
  const sections = inSource
    .map((sec) => ({
      ...sec,
      focusX: sec.focusX ?? focusOf(sec.start, sec.end),
      // Whether the anchor was chosen or computed — the declare-focus rule
      // reports it, because a computed one is right most of the time and
      // silently wrong when the subject sits in a side panel.
      focusExplicit: sec.focusX !== undefined,
      start: map(sec.start),
      end: Math.min(map(sec.end), bodyDuration),
    }))
    .filter((sec) => sec.end - sec.start >= config.list.minHold && sec.items?.length);
  config.sections = sections;

  const regions = zoomPlan({
    samples: motion.samples,
    sampleFps: motion.sampleFps,
    opts: config.zoom,
    map,
    bodyDuration,
    sections: inSource,
  });
  const zoomAt = zoomTrack(regions, { ramp: config.zoom.ramp, panMs: config.zoom.panMs });

  const timeline = buildTimeline({ config, bodyDuration });

  console.log(
    `plan  : ${dead.length} dead run(s), ${cuts.segments.length} segment(s), ` +
    `${cuts.removed.toFixed(1)}s removed -> body ${bodyDuration.toFixed(1)}s`,
  );
  console.log(`        ${regions.length} zoom region(s)`);
  for (const sec of sections) {
    console.log(
      `        list ${sec.start.toFixed(1)}-${sec.end.toFixed(1)}s  "${sec.headline}"  ` +
      sec.items.map((i) => `• ${i}`).join('  '),
    );
  }
  console.log(
    `        opening ${timeline.titleEnd.toFixed(1)}s + body + outro ` +
    `= ${timeline.total.toFixed(1)}s total`,
  );

  // ---- house rules ----
  // Held against the plan rather than the finished file, because that is where
  // the remedy is cheap: every fix is a line in the sidecar, and a rule found
  // broken after the encode has cost the encode. Under `rules.strict` this
  // stops the run here.
  const rules = reportRules({ sections, drafted: drafted.length, regions, timeline }, config);

  // The plan is written on every run, not only under --analyze-only: it is the
  // record of what was decided and which rules the decision was held to, and a
  // finished lesson with no such record cannot be argued with later.
  const report = {
    source,
    cuts,
    regions,
    sections,
    timeline,
    copy: config.copy,
    rules: rules.verdicts,
  };
  const reportFile = path.join(work, `${stem}.plan.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`wrote ${path.relative(ROOT, reportFile)}`);

  if (analyzeOnly) return null;

  // ---- tighten ----
  const tightFile = path.join(work, 'body.mkv');
  process.stdout.write('tighten: ');
  const body = applyCuts({
    input: take,
    output: tightFile,
    segments: cuts.segments,
    hasAudio: source.hasAudio,
    fps: config.fps,
  });
  console.log(body.reencoded ? `${path.relative(ROOT, body.file)}` : 'nothing to cut, using source');

  const realBody = body.reencoded ? durationOf(body.file) : takeDuration;

  // ---- render ----
  const pictureFile = path.join(work, 'picture.mp4');
  const t0 = Date.now();
  const result = await render({
    bodyFile: body.file,
    output: pictureFile,
    config,
    brand,
    art,
    fonts,
    zoomAt,
    bodyDuration: realBody,
    onProgress: (n, total) => {
      const pct = ((n / total) * 100).toFixed(0);
      process.stdout.write(`\rrender : ${n}/${total} frames (${pct}%)   `);
    },
  });
  process.stdout.write('\r');
  console.log(
    `render : ${result.frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s — ` +
    `recording matted at ${result.window.w}x${result.window.h}` +
    (result.heldFrames
      ? `, ${(result.heldFrames / config.fps).toFixed(1)}s of blank screen held`
      : ''),
  );

  // ---- sound ----
  const musicFile = !config.audio.music
    ? null
    : config.audio.musicFile
      ? path.resolve(config.audio.musicFile)
      : findMusic(brandFile('music'));

  const cues = config.audio.sfx
    ? cuesFor(brandFile('sfx'), result.timeline, config.frame)
    : [];

  // The gaps to duck: the take's own silences, remapped onto the cut body. This
  // is the one piece of noise treatment that cannot damage the narration,
  // because it only ever acts inside spans the analyser called silent.
  const duckSpans = sound
    ? sound.silence
        .map(([a, b]) => [map(a), Math.min(map(b), bodyDuration)])
        .filter(([a, b]) => b - a >= config.audio.duckMin)
    : [];

  // The bed sits under the recording only — the opening and the outro carry the
  // transition cues over silence, the way the examples do.
  const bed = musicFile ? musicGain(musicFile, config.audio.musicTargetDb) : null;

  const audioOpts = {
    ...config.audio,
    // The denoiser works from the take's own floor rather than a constant.
    noiseFloorDb: sound ? sound.floorDb : config.audio.noiseFloorDb,
    duckSpans,
    musicGainDb: bed?.gainDb ?? 0,
    bedFrom: result.timeline.bodyStart,
    bedUntil: result.timeline.outroStart,
    bitrate: config.encode.audioBitrate,
  };

  if (source.hasAudio) {
    // Measure the cleaned narration before normalising it. Single-pass loudnorm
    // under-corrects a quiet, wide-range take by several decibels.
    audioOpts.measured = measureLoudness(body.file, cleanChain(audioOpts), config.audio.loudness);

    buildAudio({
      picture: pictureFile,
      body: body.file,
      output,
      music: musicFile,
      cues,
      offset: result.timeline.bodyStart,
      total: result.duration,
      opts: audioOpts,
    });
    console.log(
      `sound  : ${config.audio.denoise ? `denoised from a ${audioOpts.noiseFloorDb.toFixed(0)} dB floor, ` : ''}` +
      `${config.audio.duck ? `${duckSpans.length} gap(s) ducked ${config.audio.duckDb} dB, ` : ''}` +
      `levelled ${audioOpts.measured ? `${Number(audioOpts.measured.input_i).toFixed(1)} -> ` : ''}` +
      `${config.audio.loudness.I} LUFS, ${cues.length} cue(s)` +
      `${bed ? `, bed ${path.basename(musicFile)} at ${config.audio.musicTargetDb} LUFS` : ', no bed'}`,
    );
    if (!musicFile) {
      console.log(
        '         note: the examples run a quiet pad under the body. Drop the ' +
        'track in assets/music and it is mixed in automatically.',
      );
    }
  } else {
    muxSilent({ picture: pictureFile, output, cues, total: result.duration, opts: audioOpts });
    console.log(`sound  : take had no audio — cues only (${cues.length})`);
  }

  const final = verify(output, { total: result.duration });

  if (!keepWork) {
    for (const f of [tightFile, pictureFile]) if (fs.existsSync(f)) fs.rmSync(f);
  }

  const mb = (fs.statSync(output).size / 1e6).toFixed(1);
  console.log(
    `\nout   : ${output}\n        ${final.duration.toFixed(1)}s, ` +
    `${final.width}x${final.height} @ ${final.fps.toFixed(0)}fps, ${mb} MB`,
  );

  return output;
}
