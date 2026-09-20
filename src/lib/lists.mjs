// Finding the moments where the narrator is listing things.
//
// The examples do something specific at those moments: the recording stops
// being the whole picture, slides right into a smaller window, and the points
// appear beside it as a checklist under a headline. Deciding *when* to do that
// is the one editorial cue in these lessons that lives in the audio and
// nowhere else — no amount of looking at the pixels tells you that "there's
// freemium, premium and sandbox" wants to be three bullets on screen.
//
// So this reads the transcript. It is deliberately narrow: it fires on an
// explicit enumeration and on nothing else. A false positive here is not a
// small blemish — it is a full-screen graphic asserting a list that the
// narrator never gave — so the bar is a sentence that is unmistakably one.

const FILLER = /^(?:so|and|but|then|now|well|okay|ok|um|uh|also|plus)\b[,\s]*/i;

const NUMBER_WORDS = {
  two: 2, three: 3, four: 4, five: 5, six: 6,
};

/** Sentences, with the time each one starts, rebuilt from whisper's chunks. */
function sentences(segments) {
  const out = [];
  let text = '';
  let start = segments[0]?.start ?? 0;
  let end = start;

  for (const seg of segments) {
    if (!text) start = seg.start;
    text = text ? `${text} ${seg.text}` : seg.text;
    end = seg.end;

    // whisper's chunks break mid-sentence; a sentence is closed by punctuation.
    while (/[.!?]/.test(text)) {
      const i = text.search(/[.!?]/);
      const head = text.slice(0, i + 1).trim();
      if (head) out.push({ text: head, start, end });
      text = text.slice(i + 1).trim();
      start = seg.start;
    }
  }
  if (text.trim()) out.push({ text: text.trim(), start, end });
  return out;
}

const tidy = (s) =>
  s.replace(FILLER, '')
    .replace(/^(?:there(?:'s| is| are)|it(?:'s| is))\s+/i, '')
    .replace(/[.,;:!?]+$/, '')
    .trim();

const titleCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Pull "A, B and C" out of a sentence.
 *
 * Requires at least three members, each short enough to be a bullet, and a
 * real conjunction before the last — which is what rules out an ordinary
 * comma-heavy sentence.
 */
function series(text) {
  // Whisper splits on breath, not on grammar, so a sentence often arrives as
  // "for connecting Salesforce, there's freemium, premium, and sandbox." The
  // list starts after the announcement, not at the first comma — taking the
  // whole thing turns the subject of the sentence into a bullet.
  const after = /\b(?:there(?:'s| is| are)|you can (?:choose|pick|use)|these are|namely)\s+([\s\S]+)$/i
    .exec(text);
  const body = after ? after[1] : text;

  const m = /([^.,;:]+(?:\s*,\s*[^.,;:]+){1,5}\s*,?\s+(?:and|or)\s+[^.,;:]+)/i.exec(body);
  if (!m) return null;

  const parts = m[1]
    .split(/\s*,\s*|\s+(?:and|or)\s+/i)
    .map((p) => tidy(p))
    .filter(Boolean);

  if (parts.length < 3 || parts.length > 6) return null;
  // Bullets are labels, not clauses. Anything long is prose that happens to
  // have commas in it.
  if (parts.some((p) => p.split(/\s+/).length > 5 || p.length > 42)) return null;
  // A series of verbs ("select settings, app marketplace, and then Salesforce")
  // is a navigation path being demonstrated on screen, not a list of concepts.
  if (parts.some((p) => /^(?:then|next|finally)\b/i.test(p))) return null;

  return parts.map((p) => titleCase(p));
}

/**
 * A headline for the card, out of the narrator's own announcement.
 *
 * "You have three options" ... "for connecting Salesforce, there's ..." is one
 * thought whisper split in two, so the qualifier is looked for on both sides
 * of the break. Keeping the narrator's words matters: an invented headline is
 * the program putting a claim on screen that nobody made.
 */
function headlineFor(context, count) {
  const m = /\b(?:there are|you (?:have|get|can (?:choose|pick) from))\s+([\w-]+)\s+([\w-]+)\b/i
    .exec(context);

  let head = count === 3 ? 'Three things to know' : 'What you get';
  if (m) {
    const n = NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
    const word =
      Object.keys(NUMBER_WORDS).find((k) => NUMBER_WORDS[k] === n) ?? m[1];
    const noun = m[2].replace(/s$/i, '');
    head = `${titleCase(word)} ${noun}${count === 1 ? '' : 's'}`;
  }

  // The qualifier: "...options **for connecting Salesforce**".
  const q = /\b(?:for|to|when|of|in)\s+((?:[\w'-]+\s+){0,2}[\w'-]+)\s*(?:,|\.|$|there(?:'s| is| are))/i
    .exec(context.replace(/^.*?\b(?:options?|ways?|choices?|kinds?|types?|things?)\b/i, ''));
  const tail = q ? q[1].trim() : '';

  return tail && tail.split(/\s+/).length <= 3 ? `${head} for ${tail}` : head;
}

/**
 * Sections drafted from the narration.
 *
 * Times are in *source* seconds. The caller remaps them through the cut plan,
 * because the author who edits them is watching the raw take, not the edit.
 */
export function detectSections(segments, { minHold = 4, maxSections = 4 } = {}) {
  if (!segments?.length) return [];

  const lines = sentences(segments);
  const found = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const items = series(line.text);
    if (!items) continue;

    // The lead-in is either the front of this sentence or the one before it —
    // "You have three options." / "for connecting Salesforce, there's ..." is
    // one thought that whisper happened to split.
    const prev = lines[i - 1]?.text ?? '';
    const lead = /\b(?:there are|you (?:have|get|can))\b/i.test(line.text) ? line.text : prev;

    // Only fire on an explicit enumeration: either a counted lead-in, or the
    // "there's A, B and C" construction. A bare comma series is not enough.
    const counted = /\b(?:there are|you (?:have|get))\s+(?:\d+|two|three|four|five|six)\s+\w+/i.test(
      `${prev} ${line.text}`,
    );
    const declared = /\bthere(?:'s| is| are)\s+[^.]*,/i.test(line.text);
    if (!counted && !declared) continue;

    const start = (i > 0 && lead === prev ? lines[i - 1].start : line.start);
    const end = Math.max(line.end, start + minHold);

    // Never overlap the previous section.
    const last = found[found.length - 1];
    if (last && start < last.end + 1) continue;

    const headline = headlineFor(`${prev} ${line.text}`, items.length);
    found.push({
      start,
      end,
      headline,
      // The examples set the closing word of the headline in the brand blue.
      highlight: [headline.split(/\s+/).slice(-1)[0]],
      items,
      source: line.text,
    });
  }

  // A lesson that is one list after another is a lesson where the device has
  // stopped meaning anything. Keep the best few, longest first.
  return found
    .sort((a, b) => b.items.length - a.items.length || a.start - b.start)
    .slice(0, maxSections)
    .sort((a, b) => a.start - b.start);
}

/**
 * Sections written by hand win over drafted ones, and a hand-written section
 * suppresses any draft it overlaps.
 */
export function mergeSections(manual = [], drafted = []) {
  const kept = [...manual].sort((a, b) => a.start - b.start);
  for (const d of drafted) {
    if (kept.some((m) => d.start < m.end && m.start < d.end)) continue;
    kept.push(d);
  }
  return kept.sort((a, b) => a.start - b.start);
}
