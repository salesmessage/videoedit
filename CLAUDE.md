# CLAUDE.md

Read `README.md` first — it explains what each stage decides and why, and every
number the look depends on lives in `src/lib/config.mjs`. This file holds only
the **house rules**: conditions on the finished edit that no measurement will
tell you, and that a take can satisfy the whole style guide while breaking.

The rules are not documentation of the code — they are enforced by it. They live
in `src/lib/rules.mjs`, each with its own reasoning and remedy, are checked at
plan time before any encode, and their verdicts are written into
`.work/<take>.plan.json` under `rules` on **every** run. So a finished lesson
carries a record of which rules it was held to and what they saw.

`rules.strict: false` by default — a broken rule warns. Set `rules.strict: true`
(sidecar or `src/lib/config.mjs`) to stop the run instead, which is what an
unattended batch wants.

---

## 1. Every video contains at least one list section

**Non-negotiable.** Never ship a lesson whose plan has `sections: []`.

`detectSections` is deliberately narrow — it fires on a counted lead-in ("three
options…") or the "there's A, B and C" construction and on nothing else, because
a false positive is a full-screen graphic asserting a list nobody gave. That
narrowness is correct for the detector, and it means a narrator who enumerates
across three sentences without counting them gets no section at all. **That is a
gap in the deliverable, not a correct read of the take.**

So when detection drafts nothing, write one by hand. Read the transcript
(`.work/<take>.transcript.json`) for the passage where the narrator enumerates,
and put it in the sidecar:

```json
"sections": [
  { "start": 45.0, "end": 68.4,
    "headline": "What you can do with Salesmsg properties",
    "highlight": ["Salesmsg properties"],
    "items": ["Active lists", "Workflow enrollment triggers", "Custom reports"],
    "focusX": 0 }
]
```

Two things about this:

- **Times are on the take's clock**, not the finished video's. They are mapped
  through the cut plan for you.
- **It will blank any zoom region underneath it**, by design — the renderer eases
  the zoom out as the card moves in. The section wins. In practice the budget
  freed often promotes weaker regions elsewhere, so the lesson does not
  necessarily end up with less movement.

Do not manufacture a list the narration does not give, and do not assert a count
the narrator did not say. If a take genuinely enumerates nothing, that is worth
raising with the person who recorded it rather than inventing a card.

## 2. A section's crop anchor is a decision, not a default

Inside a section the recording is **cropped at the same magnification, not
shrunk** — that is why the interface stays readable at a third of the width. So
only about 45% of the width survives and which part is the whole question.

`focusOf` picks it by motion salience. That is the right default and it has one
recurring failure: an app whose subject sits in a left-hand panel while the
cursor wanders the empty canvas beside it pulls the anchor to the middle and
slices the panel in half. You only see it after the render.

So check the computed anchor against a frame from the middle of the section
before committing to an encode, and set `focusX` explicitly when the subject is
in a side panel — `0` is the left edge, `1` the right, and left is the reference
lessons' own choice. The `declare-focus` rule prints every anchor and whether it
was set or computed; it is advisory and will not fail a plan.

## 3. Keep the take's own narration unless asked otherwise

`--narrate` is off by default and stays off unless the person asks for it: it
bills a third-party API and it throws away the performance the take was recorded
with. Do not turn it on to tidy up a transcription error.

## 4. Record transcript corrections even when the voice is kept

When you find a mishearing in the transcript, put it in `narration.fixes` in the
sidecar anyway. It is inert while the original voice is kept — the transcript is
only read by the list detector, which looks at sentence shape — but it is live
the moment anyone runs `--narrate`, and it is the only durable record that the
word on screen was wrong. Verify against the picture before writing one: a frame
from the moment usually settles it (a "customer ports" that the screen shows to
be HubSpot's custom report builder).

Fix names only where the spelling changes the sound. "Salesmsg" is pronounced
"sales message", which is exactly why whisper writes it that way — leave it.

## 5. Copy is editorial; it comes from the person, via the sidecar

`badge`, `headline`, `highlight` and `introWord` are derived from the file name
only as a starting point. When someone supplies them, write them into the
sidecar beside the take (`<take name>.json`) rather than passing them as CLI
flags — the sidecar is the durable record of how that lesson was cut, and a flag
is gone as soon as the shell scrolls.

## 6. Measure, do not eyeball, when checking a change

The look was matched to `reference/` by measurement, so a change is only known
to hold by taking the same measurement again:

```
node tools/inspect.mjs frame "reference/….Output.mp4" "out/….Output.mp4"
node tools/inspect.mjs audio "out/….Output.mp4"
```

`frame` samples the middle of the file, so on a lesson with a section there it
reports the section's smaller window rather than the mat — read the render
line's own `recording matted at WxH` for that. Expect `audio` to land near
−42 dBFS quiet with ~4.5 dB phrase spread. Loudness range runs wide (well above
the examples' 5 LU) whenever the original voice is kept; that is documented and
expected, not a regression.

## 7. What the pipeline cannot fix, say out loud

Screen-recorder control widgets, mouse trails, notification toasts, a wrong tab
— these are baked into the source pixels and nothing downstream removes them.
Flag them to the person with the timestamp; do not quietly ship around them and
do not try to paint over them.
