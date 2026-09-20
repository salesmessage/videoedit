// Turning the analysis into an edit.
//
// Two things come out of here and they have to agree with each other. The cut
// plan says which stretches of the take survive and how fast each is played.
// The zoom plan says where to look and when. The zoom plan is written against
// the *original* take, because that is what was analysed — so it is remapped
// through the cut plan before anyone uses it. Doing that in one place is the
// only reason the two cannot drift apart.

/** Segments of the source that survive, in order, each with a playback rate. */
export function cutPlan({ duration, dead, speech, opts }) {
  if (!opts.enabled) {
    return { segments: [{ from: 0, to: duration, speed: 1 }], removed: 0 };
  }

  const segments = [];
  let cursor = 0;

  // Head. A take usually opens with the recorder already rolling while nothing
  // happens yet. Start just before the first thing that does.
  const firstEvent = speech.length ? speech[0][0] : 0;
  const headTrim = Math.max(0, Math.min(firstEvent - opts.head, duration * 0.5));
  if (headTrim > 0.2) cursor = headTrim;

  for (const [a, b, frozen] of dead) {
    if (b <= cursor) continue;
    const from = Math.max(a, cursor);
    if (b - from < opts.min) continue;

    // A dead run reaching the end of the take is the recorder still going
    // after the demo finished. Trim it to `tail` rather than speeding it up:
    // a 4x fast-forward over the closing frame is a glitch, not an edit.
    if (b >= duration - 0.3) {
      const end = Math.min(b, from + opts.tail);
      if (end > cursor) segments.push({ from: cursor, to: end, speed: 1 });
      cursor = duration;
      break;
    }

    if (from > cursor) segments.push({ from: cursor, to: from, speed: 1 });

    const span = b - from;
    if (frozen) {
      // Every frame in a frozen run is the same frame, so dropping most of
      // them is not a cut the viewer can see — it is the pause getting shorter.
      segments.push({ from, to: from + Math.min(span, opts.keep), speed: 1 });
    } else {
      // Something is still moving — a spinner, a caret. Squeeze rather than
      // splice, so the motion stays continuous across the join.
      segments.push({ from, to: b, speed: Math.min(opts.speed, Math.max(1, span / opts.keep)) });
    }
    cursor = b;
  }

  if (cursor < duration) segments.push({ from: cursor, to: duration, speed: 1 });

  // `duration` may be shorter than the take — the caller trims the tail so the
  // closing line meets the outro — so nothing is allowed past it. A dead run
  // straddling the end would otherwise put back the seconds just removed.
  const clipped = [];
  for (const s of segments) {
    if (s.from >= duration) continue;
    clipped.push({ ...s, to: Math.min(s.to, duration) });
  }

  const kept = clipped.reduce((s, g) => s + (g.to - g.from) / g.speed, 0);
  return {
    segments: clipped.filter((s) => s.to - s.from > 1 / 120),
    removed: duration - kept,
  };
}

/**
 * A function from a time in the source take to a time in the cut body.
 * Anything that fell inside a trim lands on the nearest surviving edge.
 */
export function timeMapper(segments) {
  const marks = [];
  let out = 0;
  for (const s of segments) {
    marks.push({ from: s.from, to: s.to, out, speed: s.speed });
    out += (s.to - s.from) / s.speed;
  }
  const total = out;

  const map = (t) => {
    if (!marks.length) return 0;
    if (t <= marks[0].from) return 0;
    for (const m of marks) {
      if (t < m.from) return m.out; // fell in a trimmed gap
      if (t <= m.to) return m.out + (t - m.from) / m.speed;
    }
    return total;
  };
  map.total = total;
  return map;
}

/**
 * Zoom regions, from where the picture was changing.
 *
 * The rule is deliberately conservative. Zooming is a claim that one part of
 * the screen matters more than the rest, and a wrong claim is worse than no
 * claim: it crops away the thing the narrator is talking about. So a stretch
 * only qualifies while the movement in it is both present and tightly
 * clustered, and a region that never settles on one place is dropped.
 */
export function zoomPlan({ samples, sampleFps, opts, map, bodyDuration, sections = [] }) {
  if (!opts.enabled) return [];

  const dt = 1 / sampleFps;

  // What counts as movement has to come from the take, the same way the speech
  // gate does. A fixed number was tuned on a lesson full of typing and
  // clicking; on a tour where the presenter talks over a still dashboard the
  // median frame-to-frame energy is literally zero and the 90th percentile sits
  // an order of magnitude under that constant, so nothing ever qualified and a
  // 112-second lesson got one 1.7-second push.
  //
  // Taking the median of the frames that moved at all admits the livelier half
  // of whatever movement this take has, which is a stable fraction whether the
  // take is busy or calm. The configured value stays as a floor, so a static
  // screen's codec noise cannot promote itself into a zoom.
  const moved = samples.map((s) => s.energy).filter((e) => e > 0).sort((a, b) => a - b);
  const gate = moved.length
    ? Math.max(opts.minActivity, moved[Math.floor((opts.activityPercentile ?? 0.5) * (moved.length - 1))])
    : opts.minActivity;

  const active = samples.map(
    (s) => s.energy >= gate && s.spread !== undefined && s.spread <= opts.maxSpread,
  );

  // A list card takes the framing over completely — the renderer eases the zoom
  // out as the card moves in — so a region planned underneath one is not just
  // wasted, it snaps back into view for whatever is left of it when the card
  // leaves. Blank those spans before the runs are built, and the planner spends
  // its attention on the passages the card is not already covering.
  for (const sec of sections) {
    const a = Math.max(0, Math.floor((sec.start - opts.ramp) / dt));
    const b = Math.min(active.length, Math.ceil((sec.end + opts.ramp) / dt));
    active.fill(false, a, b);
  }

  // Bridge the gaps. Typing pauses between words; a menu sits open for a beat
  // before the next click. Without this every keystroke would be its own
  // region and the frame would pump.
  const gapFrames = Math.round(opts.gap / dt);
  for (let i = 0; i < active.length; i++) {
    if (active[i]) continue;
    let j = i;
    while (j < active.length && !active[j]) j++;
    if (i > 0 && j < active.length && j - i <= gapFrames) active.fill(true, i, j);
    i = j - 1;
  }

  const runs = [];
  for (let i = 0; i < active.length; i++) {
    if (!active[i]) continue;
    let j = i;
    while (j < active.length && active[j]) j++;
    runs.push([i, j]);
    i = j - 1;
  }

  const regions = [];
  for (let [i, j] of runs) {
    // A run longer than maxHold is not one moment of attention, it is a whole
    // passage. Split it so the frame eases back out and picks the next focus
    // rather than staying clamped on a stale one.
    const maxFrames = Math.round(opts.maxHold / dt);
    while (j - i > 0) {
      const end = Math.min(j, i + maxFrames);
      const slice = samples.slice(i, end).filter((s) => s.cx !== undefined);
      const span = (end - i) * dt;

      if (span >= opts.minHold && slice.length >= 3) {
        // Weight the focus by how much moved, so a stray flicker in the corner
        // does not drag the frame away from the thing being demonstrated.
        let wsum = 0, cx = 0, cy = 0;
        for (const s of slice) { wsum += s.energy; cx += s.cx * s.energy; cy += s.cy * s.energy; }
        cx /= wsum || 1;
        cy /= wsum || 1;

        // Follow the focus across the region rather than holding one point:
        // a form gets filled top to bottom, and a fixed centre loses the end of
        // it. Points are thinned to roughly one per second.
        const step = Math.max(1, Math.round(sampleFps));
        const track = [];
        for (let k = 0; k < slice.length; k += step) {
          const chunk = slice.slice(k, k + step);
          let ws = 0, tx = 0, ty = 0;
          for (const s of chunk) { ws += s.energy; tx += s.cx * s.energy; ty += s.cy * s.energy; }
          if (ws > 0) track.push({ t: chunk[0].t, cx: tx / ws, cy: ty / ws });
        }

        const spread = slice.reduce((s, x) => s + x.spread, 0) / slice.length;
        regions.push({
          start: samples[i].t,
          end: samples[Math.min(end, samples.length) - 1].t,
          cx, cy,
          // A tight cluster earns a deeper look than a loose one, in
          // proportion — so a menu opening is pushed in on and a half-page
          // repaint gets a nudge rather than the same hard shove.
          z: 1 + (opts.depth - 1) *
            Math.min(1, Math.max(0, (opts.maxSpread - spread) / opts.maxSpread)),
          // How much this region deserves the budget below: how much moved,
          // per frame, weighted by how tightly it clustered.
          score: (wsum / slice.length) *
            Math.min(1, Math.max(0, (opts.maxSpread - spread) / opts.maxSpread)),
          track: track.length ? track : [{ t: samples[i].t, cx, cy }],
        });
      }
      // Leave a real breath before the next slice of the same run. Without it
      // the chunks come out contiguous and the merge below joins them straight
      // back together, which is how a 20s cap produced a 40s hold: the split
      // happened and was then undone. The gap has to clear the same threshold
      // the merge uses, so the frame actually eases out and re-picks its focus.
      i = end + Math.ceil((opts.ramp * 2 + 0.5) / dt);
    }
  }

  // Remap onto the cut body, then drop anything the tightening squeezed below
  // the minimum — a region that survives as half a second of zoom is a flinch.
  const out = [];
  for (const r of regions) {
    const start = map(r.start);
    const end = Math.min(map(r.end), bodyDuration);
    if (end - start < opts.minHold) continue;
    const track = r.track
      .map((p) => ({ t: map(p.t), cx: p.cx, cy: p.cy }))
      .filter((p) => p.t >= start && p.t <= end);
    const last = out[out.length - 1];
    // Regions that now touch would make the zoom track non-monotonic.
    if (last && start < last.end + opts.ramp * 2) {
      last.end = Math.max(last.end, end);
      last.track.push(...track);
      last.score = Math.max(last.score, r.score);
      continue;
    }
    out.push({
      start, end, cx: r.cx, cy: r.cy, z: r.z, score: r.score,
      track: track.length ? track : [{ t: start, cx: r.cx, cy: r.cy }],
    });
  }

  // Spend a budget rather than taking everything that qualifies.
  //
  // Whether a passage is zoomable says nothing about whether it should be: a
  // busy lesson has plenty that qualifies, and honouring all of it means the
  // frame is pushed in over half the runtime, which reads as restlessness
  // rather than emphasis. The example spends about a fifth of its body on two
  // moves. So the strongest regions are kept until the budget is gone and the
  // rest are left at 1.0 — on a calm take nothing is dropped, and on a busy one
  // what survives is what moved most in the tightest space.
  const budget = (opts.maxCoverage ?? 1) * bodyDuration;
  const total = out.reduce((s, r) => s + (r.end - r.start), 0);
  if (total <= budget) return out;

  const kept = [];
  let spent = 0;
  for (const r of [...out].sort((a, b) => b.score - a.score)) {
    const span = r.end - r.start;
    if (spent + span > budget && kept.length) continue;
    kept.push(r);
    spent += span;
  }
  return kept.sort((a, b) => a.start - b.start);
}

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The zoom regions flattened into one keyframe track, and a sampler over it.
 *
 * Between regions the track sits at z=1, where the focus point is irrelevant
 * because it clamps to centre anyway — so interpolating straight across a gap
 * is safe and gives the ease-out for free.
 */
export function zoomTrack(regions, { ramp, panMs }) {
  const keys = [];
  const push = (t, z, cx, cy) => {
    const at = keys.length ? Math.max(t, keys[keys.length - 1].t) : t;
    keys.push({ t: at, z, cx, cy });
  };

  for (const r of regions) {
    const span = r.end - r.start;
    const ease = Math.min(ramp, span / 2);
    const holdFrom = r.start + ease;
    const holdTo = r.end - ease;

    const pts = r.track.filter((p) => p.t >= r.start && p.t <= r.end);
    const first = pts[0] ?? { cx: r.cx, cy: r.cy };

    push(r.start, 1, first.cx, first.cy);
    push(holdFrom, r.z, first.cx, first.cy);

    let prev = first;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      // Ignore a focus that barely moved: panning 2% of the frame is a wobble.
      if (Math.hypot(p.cx - prev.cx, p.cy - prev.cy) < 0.05) continue;
      const arrive = Math.min(Math.max(p.t, holdFrom), holdTo);
      const depart = Math.max(holdFrom, arrive - panMs / 1000);
      if (arrive <= depart) continue;
      push(depart, r.z, prev.cx, prev.cy);
      push(arrive, r.z, p.cx, p.cy);
      prev = p;
    }

    push(holdTo, r.z, prev.cx, prev.cy);
    push(r.end, 1, prev.cx, prev.cy);
  }

  return function at(t) {
    if (!keys.length) return { z: 1, cx: 0.5, cy: 0.5 };
    if (t <= keys[0].t) return keys[0];
    if (t >= keys[keys.length - 1].t) return keys[keys.length - 1];
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t < t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const span = b.t - a.t;
    const k = span <= 0 ? 1 : easeInOutCubic((t - a.t) / span);
    return { z: a.z + (b.z - a.z) * k, cx: a.cx + (b.cx - a.cx) * k, cy: a.cy + (b.cy - a.cy) * k };
  };
}
