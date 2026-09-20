# videoedit

Drop a raw screen recording into `in/`, get a finished branded lesson in `out/`.

```
npm install
npm start
```

A take is any video in `in/` whose name ends **" Source"**. It becomes
**"… Output.mp4"** in `out/`. That pairing is the whole bookkeeping: a take that
already has an output is considered done, so re-running is safe and picks up
only what is new.

```
in/  Connecting Salesforce Source.mp4
out/ Connecting Salesforce Output.mp4
```

`npm run watch` stays running and processes takes as they land — it waits for
each file to stop growing first, so a copy still in progress is not read
half-written.

Out comes 1920×1080 at 30 fps: dead air tightened, the recording matted on the
brand field with an automatic zoom that follows what is happening on screen, an
animated logo opening, a title card, a closing lockup, the brand's transition
sounds at the joins, a music bed under the body, and the narration cleaned and
levelled. Where the narrator enumerates something, the recording slides right
and the points appear beside it as a checklist. Optionally the narration is
replaced entirely with text to speech.

A four-minute lesson takes roughly 12–20 minutes, nearly all of it in the frame
loop.

---

## Layout

```
in/          drop takes here          out/        finished lessons appear here
reference/   the hand-finished lessons the look was measured against
models/      speech model (downloaded on demand)
.work/       intermediates, disposable
.cache/      rendered speech, keyed by content — deleting it costs money, not correctness

brand/       everything the look is made of
  StyleGuide.txt   colour and type
  logo/            lockup art
  fonts/           the brand's typefaces
  sfx/             four transition cues
  music/           the bed

src/
  index.mjs        the CLI: inbox, batch, watch
  run.mjs          one take, all the way through
  stages/          analyse → narrate → plan → tighten → render → sound
  lib/             paths, config, rules, brand, ffmpeg, cards, background, tts, lists, env
tools/
  inspect.mjs      measure a finished lesson (frame | audio | opening)
  extract-bed.mjs  recover the music bed from a finished lesson
```

`docs/` holds the C4 diagrams — context, containers and two component views —
in PlantUML and Mermaid. `CLAUDE.md` holds the house rules the pipeline checks.

`brand/` is the swappable part. A second brand is a second folder with the same
shape — point `VIDEOEDIT_BRAND` at it and nothing in the code changes.
`VIDEOEDIT_IN`, `VIDEOEDIT_OUT` and `VIDEOEDIT_MODELS` move the other locations.

## Requirements

- Node 18+
- ffmpeg and ffprobe on `PATH`, or `FFMPEG` pointing at the binary
  (`winget install Gyan.FFmpeg`). List sections need a build with
  `--enable-whisper`; without one, run `--no-lists`.
- For list sections, the speech model, once:
  ```
  curl -L -o models/ggml-base.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  ```
- For `--narrate`, an `ELEVENLABS_API_KEY` in `.env` (copy `.env.example`).

---

## What each stage decides

| stage | what it decides |
| --- | --- |
| **letterbox** | Whether the take has black bars baked into it, and trims them off before anything measures the frame. |
| **analyse** | Where the narration is, where the picture is still, where it is changing, which frames show nothing, and what is being said. |
| **narrate** | Optionally re-voices the take, keeping every line on the mark the original one had. |
| **plan** | Which stretches survive and at what speed; which moments deserve a zoom and where to point it; which moments want a list card. |
| **tighten** | Cuts picture and sound together in one filtergraph, so they cannot drift apart. |
| **render** | One frame loop paints the opening, the title card, the matted recording, the list sections and the outro onto a single continuous timeline. |
| **sound** | Cleans the narration, levels it two-pass, places the cues and the bed, muxes. |

Before the render, the plan is held against the **house rules** in
`src/lib/rules.mjs` — conditions on the edit rather than numbers describing the
look, chief among them that every lesson carries at least one list section. See
`CLAUDE.md`. Their verdicts are printed and written into
`.work/<take>.plan.json` under `rules`, which is now written on every run and
not only under `--analyze-only`. `rules.strict` turns a warning into a stopped
run, before the encode.

Everything the look depends on is a number in `src/lib/config.mjs`, and every
one of them can be overridden per video.

---

## The decisions worth knowing about

### The delivery frame is not the picture

A take does not always fill the frame it is delivered in. `[T1] 1.2` is 1920x1080
with 74px of black above the dashboard and 76 below — 1920x930 of actual
picture. Nothing downstream survives that on its own: the matting fits whatever
frame it is handed, so a seventh of the card becomes dead black inside the pale
ring; the zoom's motion salience sees a large region that never changes and
biases away from it; blank detection reads the standard deviation of a frame
that is part black and scores every screen lower than it deserves.

So the bars come off first, before any measurement. Detection samples nine
frames spread through the take and keeps only the crop *every* sample agrees on
— one frame is not safe, because a lesson that opens on a dark splash or shows a
black-backgrounded panel would otherwise have its own content cropped away. It
re-encodes rather than threading a crop through each stage's decode, which is
the slower choice and the right one: a crop that one stage forgets is a bug
nobody catches until the framing is wrong in a lesson that is already rendered.

`frame.letterbox.trim: false` turns it off; `frame.letterbox.crop` forces a
rectangle.

### The examples are typeset in a font that is not in the brand folder

The title card was matched to `reference/[T1] 4.2` by measurement, and one
reading would not reconcile. Its headline's x-height to cap-height ratio is
0.702, which is Neue Einstellung (0.697) — the right family. But every glyph is
about 12% narrower than that face draws at the same cap height, and the 'M'
settles it: 91x94 in the example, where Neue Einstellung Bold at cap 94 sets 103
wide. A single glyph's ink width cannot be changed by tracking, so this is not
spacing. It is a condensed cut that is not in `brand/fonts`, or type the
designer squeezed in the editor.

Both possibilities produce the same pixels, so the pipeline reproduces it as a
squeeze: `title.headlineScaleX` at 0.87 on a 134px size. That lands line one at
1306px against the example's 1307 and the cap height exactly. Rendering the
example's own copy through the pipeline reproduces its title card within 2px
everywhere — but the underlying face is still not the one that set it, so a
glyph compared in isolation will differ slightly.

### Thresholds come from the take, not from a constant

These recordings come off different mics in different rooms. The one this was
built against averages −36 dBFS, so a −40 dB silence gate — a perfectly
reasonable number — finds no silence in it at all, and the tightening stage
silently does nothing. The gate is placed a third of the way from each take's
own noise floor to its own speech level instead, which works on the quiet take
and the loud one both.

The zoom gate went the other way for a while and it is worth recording why. It
was a fixed energy figure, tuned on a lesson full of typing and clicking. On a
tour where the presenter talks over a mostly static dashboard, the median
frame-to-frame energy is *zero* and the 90th percentile sits an order of
magnitude below that figure — so nothing ever qualified, and a 112-second lesson
came out with a single 1.7-second push. The gate is now the median energy of the
frames that moved at all, per take; the configured `zoom.minActivity` survives
only as a floor, so a static screen's codec noise cannot promote itself into a
zoom.

### The zoom follows motion, because there is no cursor to follow

A recording that arrives as a finished mp4 carries no telemetry: no cursor
track, no clicks. But the thing a click *does* — a menu opens, a field fills, a
row highlights — changes pixels in one small place, and that is the same signal.
Each moment is scored on how much moved, where, and how widely spread it was.

Spread is what separates a click from a scroll: a menu opening moves a handful
of neighbouring cells and is worth pushing in on; a page scroll moves all of
them, and zooming into its centroid would crop away the thing being scrolled
past.

**A zoom is a passage, not a reaction.** This is the part that took longest to
get right, and the examples are unambiguous about it: 4.2 pushes in at 28s and
stays in until 48 — twenty seconds at 1.16 — then again for seven seconds at
122. About a fifth of its body, across two moves. It is not chasing clicks.

So `zoom.gap` bridges five seconds of stillness rather than one, which is what
turns scattered activity inside one topic into a single hold instead of a series
of twitches. `zoom.maxHold` caps a hold at the example's own longest, 20s, and
`zoom.depth` is 1.2 against the 1.16 the example sustains — shallow enough that
the recording is never scaled past 1:1 inside the card, so the push in costs no
sharpness.

**Qualifying is not the same as deserving.** Every rule above answers whether a
stretch *can* be zoomed. None answers whether it *should* be, and on a busy take
that gap is wide: the inbox lesson offered 52% of its body across ten regions,
each defensible alone, all of them together a frame pushed in for half the
runtime. `zoom.maxCoverage` (0.25) is the ceiling. When the total exceeds it,
regions are ranked by how much moved per frame weighted by how tightly it
clustered — the same tightness term that sets the depth — and taken strongest
first until the budget is gone; the rest stay at 1.0. It is a no-op below the
ceiling, so a calm take is untouched.

    dashboard tour   17% qualified   17% kept   (budget never binds)
    inbox lesson     52% qualified   21% kept   (5 of 10 regions)

**Nothing is planned under a list card.** The renderer eases the zoom out as the
card moves in, so a region underneath one is not merely wasted — it snaps back
into view for whatever is left of it when the card leaves. Those spans are
blanked before regions are built, on the take's own clock rather than the cut
body's, which matters as soon as anything upstream of a section is trimmed.

### Background noise is removed by name, not by level

Three things had to be measured before this came out right.

The spectral denoiser *does* work, but only on hiss — it takes 12.5 dB out of
the 2–8 kHz band and barely moves the overall gap level, because what dominates
there is low-frequency room and mouse clicks. Its noise floor is tied to the
take's own measured one; set lower, it does much less.

A downward expander looked like the answer for the gaps and was the wrong
answer: the quiet end of this narrator's range sits in the same band as the
room, so it ate speech, and the variation between spoken phrases went from
4.4 dB to 7.8 dB. **A viewer forgives room tone and does not forgive a sentence
they cannot hear.** What works instead is not a level decision at all — the
analyser already knows where the narrator stopped talking, so those spans are
ducked 20 dB by name, which cannot touch speech by construction.

And the high-pass has to sit **below the voice**. This narrator's fundamental
has a median of 111 Hz and a fifth percentile of 73, so the 110 Hz corner that
seemed sensible was cutting straight through it. 75 Hz is the floor here.

Measured: the level where nobody speaks drops from −27 to −42 dBFS while the
phrase-to-phrase spread stays at 4.5 dB. loudnorm runs two-pass, because
single-pass under-corrects a quiet, wide-range take by four or five decibels.

### Blank screens are held, not shown

A recording of a real app spends time showing nothing: a tab that has not
painted, the dark plum a Salesforce page sits on while it loads. On the take
this was built against that is 38 seconds of 272 — dead screen time a viewer
reads as a fault in the video rather than in the app.

Those frames are dropped and the last frame that had something on it is held
instead. Detection is a detail measure (the standard deviation of the frame),
and the two populations do not overlap: blanks sit at 0.6, the quietest real
screen at 14.8.

The test runs on the frame in hand, not on stretches computed during analysis
and mapped onto the edited timeline. The mapped version was right about *where*
the blanks were and still showed them: the spans were inset slightly at each end
so the hold would not freeze over real content, which let the first two
genuinely blank frames through — and the hold then faithfully held one of those.
A per-frame test cannot have an off-by-a-frame.

### The music bed is a loop, and that is how it was recovered

The hand-finished lessons run a very quiet sustained pad under the body. It does
not show on a level meter, but it repeats: the spectrogram's self-similarity
peaks at 10.67 s and again at every multiple. Refined against the waveform the
period is 512001 samples at 48 kHz — 512000 to within one sample, a round number
as a rendered loop would be.

Fourteen repeats fit between the opening and the outro, and that is fourteen
observations of the *same* bed with *different* speech on top. Speech only ever
adds energy, so per frequency bin the smallest magnitude across the fourteen is
the bed. One whole period then loops with no crossfade at all.

That pad also **masks the residual room tone under the narration**, which is why
those lessons sound clean even though their own gaps measure noisier than this
pipeline's.

Three details the reconstruction gets wrong if you skip them, each of which it
did once: phase must come from one repeat per frame and not per bin (per bin
reconstructs as noise, not a chord); the opening and outro digital silence must
stay out of the window (it is the smallest thing in every bin, so it punches a
one-second hole through the loop); and so must the bed's own two-second fade-in
(it drags the head of the loop down and leaves an 8 dB step at the wrap).

### The examples disagree with each other

The two hand-finished lessons mat the recording differently — 144 px from the
sides in one, 200 px in the other. No single rule produces both, so the defaults
follow the one whose take is the same shape as everything else out of this
recording setup. Override `frame.paddingX` per video.

---

## Per-video overrides

Badge and headline default to the file name. `[T1] 4.2 — Managing Conversations
in Your Inbox Source.mp4` becomes the badge `T1 4.2` and the headline "Managing
conversations in your inbox" — sentence case, with product names left alone
(`properNouns` in the config).

That is a starting point, not the finished thing. Which words go blue, and what
the badge says, are editorial. Give them on the command line:

```
npm start -- --badge "Module 3: Integrations" \
             --title "Connecting Salesforce to Salesmsg" \
             --highlight "Salesforce" \
             --intro "academy"
```

…or in a JSON file beside the take, named after it — `My Lesson Source.json` for
`My Lesson Source.mp4`, or `video.json` for the whole folder. **Any key in
`src/lib/config.mjs` can be overridden at the same path:**

```json
{
  "copy": {
I 
  },
  "frame":     { "paddingX": 144 },
  "zoom":      { "depth": 1.5, "maxCoverage": 0.35 },
  "tighten":   { "min": 2.5 },
  "narration": { "replace": true, "fixes": { "Owlbound": "Outbound" } },
  "sections":  [ { "start": 19.4, "end": 30.0,
                   "headline": "Three options for connecting Salesforce",
                   "highlight": ["Salesforce"],
                   "items": ["Freemium", "Premium", "Sandbox"] } ]
}
```

`copy.introWord` is the word after the logo in the opening — "academy",
"university", "training", or `""` for the logo alone. The lockup re-centres and
the animation rebuilds around whatever length it is.

`zoom.maxCoverage` is the share of the body that may be zoomed at all — see
[the zoom section](#the-zoom-follows-motion-because-there-is-no-cursor-to-follow).
Raise it for a take that earns more movement, or set it to `1` to take
everything that qualifies. There is no command-line flag for it; `--no-zoom`
turns zooming off entirely and is the only zoom switch on the CLI.

`narration.fixes` corrects what the transcriber misheard, before the line is
spoken — see [replacing the narration](#replacing-the-narration).

Section times are given on the **take's** clock, not the finished video's, and
are mapped through the cut plan for you.

---

## List sections

When the narrator enumerates — "you have three options … there's freemium,
premium and sandbox" — the recording slides right into a smaller window and the
points appear beside it under a headline, one at a time, each with a blue check.

Deciding *when* is the one editorial cue that lives in the audio and nowhere
else, so the narration is transcribed (whisper, through ffmpeg's own filter — no
separate binary) and the enumeration is found in the text. Detection is
deliberately narrow: it fires on a counted lead-in or the "there's A, B and C"
construction and on nothing else, because a false positive is not a small
blemish — it is a full-screen graphic asserting a list nobody gave. Navigation
paths ("select settings, app marketplace, and then Salesforce") are rejected.

One thing about the layout is not obvious from watching it: the recording inside
the smaller window is at **exactly the same magnification** as before, anchored
to one edge. It is a crop, not a shrink — which is why the interface stays
readable at a third of the width. The examples anchor left; this anchors on
wherever the picture was busiest during the section, because anchoring left on a
settings page keeps the sidebar and cuts away the panel being discussed.

Check what it found before spending an encode:

```
npm run plan
...
        list 14.5-29.0s  "Three options for connecting Salesforce"  • Freemium  • Premium  • Sandbox
```

A hand-written section suppresses any drafted one it overlaps. `--no-lists`
turns the whole thing off and skips transcription, which is the slowest stage
after rendering.

---

## Replacing the narration

```
npm start -- --narrate
```

Off by default, deliberately: it bills a third-party API and it throws away the
performance the take was recorded with.

**The hard part is not the speaking, it is the timing.** The picture already
exists and was cut to a human reading at their own pace, so every synthesised
line has to land where the original one did or it stops describing what is on
screen. Each line is anchored to the moment the original started and may only
ever be *delayed*, never brought forward: the picture cuts to whatever the line
is about, and a line that arrives early describes something not yet there. Where
a line would run into the next it is compressed, capped at 1.15× — past that the
voice sounds hurried, and a hurried line in sync is worse than a calm one a
quarter-second late.

The closing line is treated specially: the recording is trimmed to just past it
(`narration.tail`), so the outro dissolves in as the voice stops rather than
leaving the screen sitting there for a few seconds first.

Getting the line times right was the whole job. Whisper breaks on breath, not on
grammar, so one chunk often holds two sentences and one sentence often spans two
chunks. Handing each sentence its parent chunk's start and end gave several
lines the same timestamp and spans totalling 87 seconds inside a 48-second clip
— which read as the voice drifting five seconds late. The times are interpolated
*within* a chunk instead, carrying a time per character, and chunks are ordered
and clipped first because whisper emits overlapping ones. Drift is then 0.01 s.

**The take's own audio must never reach the mix**, and the stage proves it rather
than assuming it. Only the picture is taken from the source; the new track is a
silent bed plus the clips. Getting that wrong does not fail — ffmpeg is happy,
the file plays, the durations are right, and even a transcript of the result
reads correctly, because the *old* voice is the one being transcribed. So after
the mux the spans between placed lines are measured: they should hold nothing
but silence, and anything above −50 dB in them stops the run.

**What the transcriber misheard gets spoken aloud.** On a take that keeps its
own voice, a transcription error costs nothing — the transcript is only read by
the list detector, which is looking at sentence shape. Re-voicing turns that same
transcript into the script, so every mistake in it becomes the narrator saying
the wrong thing. Whisper hears a product name it has never seen and writes down
what it sounded like ("Owlbound" for Outbound), and it will occasionally emit a
word nobody said at all — one lesson here contains a lone `Dallas!`.

`narration.fixes` is a map of what to correct, applied to each line before it is
spoken and before the cache is keyed, so a corrected line cannot come back from
the cache with the mishearing still in it. Matching is case-insensitive and, where
the phrase ends in a word character, bounded — `"care"` cannot rewrite
`"careful"`. A fix that empties a line drops it, which is how a hallucination is
removed: the right thing to speak in place of `Dallas!` is nothing.

Two things it cannot do, both worth knowing before you write one. It works on a
line — a sentence — so a mishearing straddling a sentence break needs two
entries: drop the stray fragment, and append its words to the line before. Order
matters there, because fixes are applied in the order the map lists them. And it
corrects the *script*, not the transcript file, which stays a true record of what
the original narrator said.

Fix names only where the spelling changes the sound. "Salesmsg" is pronounced
"sales message", which is exactly why whisper writes it that way — replacing it
with the literal brand spelling invites the voice to spell out the letters.

Two things switch off automatically when narration is synthetic: the denoiser
and the gap duck. There is no room tone to remove, and leaving them on would
only risk chewing the new voice.

Clips are cached in `.cache/tts` by provider, voice, settings and text, so
re-rendering after changing the title card or the zoom costs nothing and
re-bills nothing. The cache deliberately sits outside `.work/`, which is cleared
between runs.

---

## Options

```
  -o, --out <file>       output path
  -c, --config <file>    JSON overrides
      --watch            stay running and process takes as they appear
      --force            re-process takes that already have an output

      --badge <text>     pill above the headline, --no-badge for none
      --title <text>     headline on the title card
      --highlight a,b    comma-separated phrases set in the brand blue
      --intro <text>     word after the logo, --no-intro-word for none

      --narrate          replace the narration with text to speech
      --voice <id>       ElevenLabs voice ID
      --no-lists         skip transcription; no list sections
      --no-zoom          leave the recording at one scale throughout
      --no-tighten       keep every pause at its original length
      --no-blank-hold    show blank screens instead of holding the last frame
      --no-sfx           no transition cues
      --no-music         no bed
      --music <file>     use this bed instead of the brand's
      --no-denoise       leave the room tone in

      --crf <n>          x264 quality, lower is bigger (default 18)
      --preset <name>    x264 speed/size tradeoff (default medium)
      --analyze-only     write the edit it would make and stop
      --keep-work        leave the intermediates in .work/
```

---

## Checking the work

The look was matched to the examples by measurement, so the only way to know it
still matches after a change is to take the same measurement again.

```
node tools/inspect.mjs frame   "reference/….Output.mp4" "out/….Output.mp4"
node tools/inspect.mjs audio   "out/….Output.mp4"
node tools/inspect.mjs opening
node tools/extract-bed.mjs     "reference/….Output.mp4" brand/music/academy-bed.wav
```

`frame` prints container, card geometry, loudness and pacing. `audio` prints the
level where nobody speaks and the variation between spoken phrases — give it two
files and the first supplies the speech map for both, which is how to compare
two treatments of the same take. `opening` renders the logo build and prints
where every glyph landed.

---

## Caveats

- **Only one example is still on disk.** `reference/` holds the `[T1] 4.2` pair.
  The title card, the mat, the opening and the outro can all be re-measured
  against it, and are. The **list card cannot** — 4.2 has no list section, so
  every number in `config.list` came from example 1.3 and nothing present can
  check it. If 1.3 turns up, put it back in `reference/`.
- **Editorial cuts are not automated.** In one example the editor removed ~23 s
  that included speech — a passage they judged unnecessary. This only removes
  dead air. On a take that talks continuously, nothing is cut and nothing should
  be: the inbox lesson's longest silence anywhere is 1.5 s.
- **The zoom budget is greedy, so it can clump.** Regions are taken strongest
  first with no preference for spreading them through the lesson. On the inbox
  lesson the two weakest survivors were dropped and the final ~70 seconds came
  out with no zoom at all. It also drops whole regions rather than shortening
  them, so one that would fit at 12 s instead of 19 is discarded entirely.
- **0.25 is fitted to a single example.** The one hand-finished lesson still on
  disk measures 19%; the ceiling sits just above so takes near that figure are
  not clipped. One example is thin evidence for a constant.
- **The badge is editorial and always was.** The example badges its card
  "Module 4: Sending and Receiving Texts" — what the module covers, which no
  file name carries. The derivation gets as far as "Module 4"; the rest is a
  sidecar's job.
- **The bed is a reconstruction, not the master.** Where the narrator never
  paused at a given point in the loop, the estimate is the quietest
  speech-contaminated observation rather than the bed itself. Inaudible at
  −34 LUFS, but if the original track turns up, drop it in `brand/music/` and
  delete the reconstruction.
- **Loudness range runs wider than the examples when the original voice is
  kept** (about 17 LU against 5). Their low figure comes from room tone lifted
  almost to speech level between words; ducking the gaps necessarily widens it.
  The speech itself is unaffected — that was measured separately. Replacing the
  narration removes the room tone at source and the figure lands where the
  examples are: `[T1] 1.2` finishes at 4.2 LU against 4.2's 5.0.
- **Transcription costs about two minutes** on a four-minute lesson. The result
  is cached per take; `--no-lists` skips it.
- **Whisper does not escape quotes in its JSON output**, so a narrator quoting
  someone produces a line `JSON.parse` refuses. The parser falls back to reading
  the fields directly; if a future model changes that format, this is the first
  place to look.
- **Rendering is single-threaded** and dominated by the canvas frame loop, at
  roughly 8–11 fps. `--preset veryfast` helps a little; most of the cost is the
  compositing, not the encode.
- **The sentence-case rule for auto-generated headlines** leaves product names
  alone via a list in the config. A product not on that list comes out
  lower-cased; add it to `properNouns` or set the headline explicitly.
