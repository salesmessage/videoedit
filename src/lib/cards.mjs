// The three things that are not the recording: the opening logo build, the
// title card, and the closing lockup.
//
// These are drawn per frame rather than rendered once and held, because they
// animate over the same drifting background as everything else. Each exported
// function paints one frame at a given local time and returns nothing; the
// caller owns the canvas and has already painted the field.

import { rgba } from './brand.mjs';

// ---- easing ----
const clamp01 = (t) => Math.min(1, Math.max(0, t));
export const easeOutCubic = (t) => 1 - (1 - clamp01(t)) ** 3;
export const easeInOutCubic = (t) =>
  (t = clamp01(t)) < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
export const easeOutQuad = (t) => 1 - (1 - clamp01(t)) ** 2;

/**
 * Exponential settle toward a target, normalised to reach it at t=1.
 *
 * This is the curve the examples' opening actually moves on — both the mark's
 * travel and the tracking collapse fit it with the same time constant (~0.24
 * of the build), which is what an editor's inertia setting produces. A cubic
 * ease is visibly too slow off the mark against it.
 */
export const easeSettle = (t, tau = 0.243) => {
  const k = clamp01(t);
  const end = 1 - Math.exp(-1 / tau);
  return (1 - Math.exp(-k / tau)) / end;
};

/** Overshoot-and-settle, for the mark popping onto an empty field. */
export const easeOutBack = (t) => {
  t = clamp01(t);
  const c = 1.7;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};

// ---- text with highlighted runs ----
// The examples set one or two words of the headline in the brand blue. Which
// words is an editorial choice, so it comes from the sidecar as a list of
// phrases; matching is done on the laid-out line rather than on the raw string
// so a phrase that wraps still colours correctly on both lines.

/** Split a line into [{text, hot}] runs, given the phrases to highlight. */
export function splitHighlights(line, phrases) {
  if (!phrases?.length) return [{ text: line, hot: false }];

  const hits = [];
  for (const phrase of phrases) {
    const p = String(phrase).trim();
    if (!p) continue;
    const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    for (let m; (m = re.exec(line)); ) hits.push([m.index, m.index + m[0].length]);
  }
  if (!hits.length) return [{ text: line, hot: false }];

  hits.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
    else merged.push([...h]);
  }

  const runs = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a > at) runs.push({ text: line.slice(at, a), hot: false });
    runs.push({ text: line.slice(a, b), hot: true });
    at = b;
  }
  if (at < line.length) runs.push({ text: line.slice(at), hot: false });
  return runs;
}

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const probe = line ? `${line} ${w}` : w;
    if (ctx.measureText(probe).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = probe;
  }
  if (line) lines.push(line);
  return lines;
}

// A greedy wrap fills the first line to the brim and dumps the remainder on
// the last, so two lines come out as a long one and a stub. Moving words back
// while that shortens the longest line evens them up.
function balance(ctx, lines) {
  if (lines.length !== 2) return lines;
  let [a, b] = lines;
  for (;;) {
    const words = a.split(' ');
    if (words.length < 2) break;
    const moved = words.pop();
    const na = words.join(' ');
    const nb = `${moved} ${b}`;
    const before = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
    const after = Math.max(ctx.measureText(na).width, ctx.measureText(nb).width);
    if (after >= before) break;
    a = na;
    b = nb;
  }
  return [a, b];
}

/**
 * Lay the headline out once, up front. The result is reused for every frame of
 * the card, so the type does not re-measure sixty times a second, and — more
 * importantly — so the per-word reveal animates over a layout that never
 * shifts under it.
 */
export function layoutTitle(ctx, { headline, highlight, style, width }) {
  // The headline is set condensed (see headlineScaleX in the config), and
  // everything measured here is measured unscaled, so the wrap has to be given
  // the width it will occupy *before* the squeeze — otherwise the lines break
  // early and the card wraps to three where the example takes two.
  const sx = style.headlineScaleX ?? 1;
  const maxWidth = (width - style.marginX * 2) / sx;
  let size = style.headlineSize;
  let lines;

  // Shrink to fit rather than overflow. A long lesson title is a fact about
  // the library, not an error, and a card that runs off the right edge is.
  for (;;) {
    ctx.font = `${style.headlineWeight} ${size}px "${style.headFont}"`;
    lines = balance(ctx, wrap(ctx, headline, maxWidth));
    if (lines.length <= style.maxLines || size <= 56) break;
    size = Math.round(size * 0.92);
  }

  const leading = Math.round((style.headlineLeading / style.headlineSize) * size);

  const laid = lines.map((line) => {
    const runs = splitHighlights(line, highlight);
    let x = 0;
    for (const r of runs) {
      r.x = x;
      r.w = ctx.measureText(r.text).width;
      x += r.w;
    }
    return { runs, width: x };
  });

  return { lines: laid, size, leading, scaleX: sx };
}

/**
 * The opening.
 *
 * Measured frame by frame off example 1.3, because the mechanic is not what it
 * looks like at a glance. It is not a wipe across the wordmark: the eight
 * letters fade in one at a time, left to right, sitting on wide tracking that
 * collapses to zero over the next second while the mark drifts left out of the
 * middle of the frame. The rule and "academy" then do the same thing again.
 *
 * That is only drawable because the logo art is sliced into its own column
 * runs at load time — one mark and eight letters — so each can be placed
 * independently while still being the real artwork rather than type set to
 * look like it.
 *
 * Timings, from the example: mark alone until 1.50s, letters from 1.55 at one
 * every 0.05s, "academy" from 2.05, everything settled at 2.65.
 */
export function drawOpening(ctx, t, { art, style, width, height, alpha = 1 }) {
  const s = style;
  const markIn = clamp01((t - s.hold) / s.markIn);
  if (markIn <= 0 || alpha <= 0) return;

  const settle = clamp01((t - s.hold - s.markIn) / s.markSettle);
  const buildAt = s.hold + s.markIn + s.markSettle;
  const p = clamp01((t - buildAt) / s.build);

  const logoH = s.lockupHeight;
  const k = logoH / art.logo.height; // art units -> screen
  const logoW = art.logo.width * k;
  const [mark, ...letters] = art.glyphs;
  const markW = mark.w * k;

  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = `${s.wordTracking}px`;
  ctx.font = `${s.wordWeight} ${Math.round(logoH * s.wordSize)}px "${s.wordFont}"`;
  const word = s.word ?? '';
  const hasWord = word.length > 0;
  const wordW = hasWord ? ctx.measureText(word).width : 0;
  const wordAt = logoW + s.dividerGap + s.dividerWidth + s.wordGap;
  const fullW = hasWord ? wordAt + wordW : logoW;

  // The mark starts centred on its own and eases to where it will sit once the
  // whole lockup exists. It does not re-centre on what is currently visible —
  // measured against the example, it heads straight for its final place.
  const soloX = width / 2 - markW / 2;
  const restX = (width - fullW) / 2;
  const settleP = easeSettle(p, s.settleTau);
  const markX = soloX + (restX - soloX) * settleP;
  const y = (height - logoH) / 2;

  // Tracking: every offset from the mark is multiplied by this, on the same
  // curve as the mark's travel — measured, not assumed; they share a time
  // constant in the example to three decimal places.
  const spread = 1 + (s.spread - 1) * (1 - settleP);

  ctx.save();
  ctx.globalAlpha = alpha;

  // 1. the mark, springing up oversize and settling to lockup size
  const pop = easeOutBack(markIn);
  const scale = pop * (s.markOversize - (s.markOversize - 1) * easeInOutCubic(settle));
  ctx.save();
  ctx.translate(markX + markW / 2, y + logoH / 2);
  ctx.scale(scale, scale);
  ctx.drawImage(
    art.logo, mark.x, 0, mark.w, art.logo.height,
    -markW / 2, -logoH / 2, markW, logoH,
  );
  ctx.restore();

  // 2. the wordmark, a letter at a time
  letters.forEach((g, i) => {
    const a = easeOutCubic((t - buildAt - i * s.glyphStagger) / s.glyphIn);
    if (a <= 0) return;
    const x = markX + (g.x - mark.x) * k * spread;
    ctx.globalAlpha = alpha * a;
    ctx.drawImage(art.logo, g.x, 0, g.w, art.logo.height, x, y, g.w * k, logoH);
  });

  // 3. the rule and the word after it, same treatment one beat later
  if (hasWord) {
    const wordFrom = buildAt + s.wordAt;
    const ruleA = easeOutCubic((t - wordFrom) / s.glyphIn);
    if (ruleA > 0) {
      ctx.globalAlpha = alpha * ruleA;
      ctx.fillStyle = s.wordColor;
      const h = logoH * s.dividerHeight;
      ctx.fillRect(
        markX + (logoW + s.dividerGap) * spread, y + (logoH - h) / 2, s.dividerWidth, h,
      );
    }

    ctx.fillStyle = s.wordColor;
    let dx = 0;
    for (let i = 0; i < word.length; i++) {
      const a = easeOutCubic((t - wordFrom - (i + 1) * s.glyphStagger) / s.glyphIn);
      if (a > 0) {
        ctx.globalAlpha = alpha * a;
        ctx.fillText(word[i], markX + (wordAt + dx) * spread, y + logoH * s.wordBaseline);
      }
      dx += ctx.measureText(word[i]).width;
    }
  }

  ctx.letterSpacing = '0px';
  ctx.restore();
}

/**
 * The title card: a pill badge that grows out of a rule, then the headline
 * revealed a word at a time.
 */
export function drawTitle(ctx, t, { layout, badge, style, brand, width, height, alpha = 1 }) {
  if (alpha <= 0) return;
  const s = style;

  const blockH = (badge ? s.pillHeight + s.pillGap : 0) + layout.lines.length * layout.leading;
  const top = Math.round((height - blockH) / 2) + (s.blockNudge ?? 0);
  const x = s.marginX;
  const sx = layout.scaleX ?? 1;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic';

  let y = top;

  if (badge) {
    ctx.font = `${s.pillWeight} ${s.pillFontSize}px "${s.bodyFont}"`;
    ctx.wordSpacing = `${s.pillWordSpacing ?? 0}px`;
    const textW = ctx.measureText(badge).width;
    const fullW = textW + s.pillPadX * 2;

    // The pill draws itself in: a thin rule at full width first, opening out
    // to the badge. Growing it from zero width instead makes the text inside
    // slide, which reads as a mistake.
    const grow = easeOutCubic(t / s.pillGrow);
    const h = Math.max(3, s.pillHeight * grow);
    const w = fullW * Math.min(1, 0.25 + 0.75 * easeOutCubic(t / (s.pillGrow * 0.8)));

    ctx.beginPath();
    // Clamped, because the pill opens from a thin rule: a 29px radius on a 3px
    // tall shape is not drawable, and the cap keeps the rule's ends round.
    ctx.roundRect(x, y + (s.pillHeight - h) / 2, w, h, Math.min(s.pillRadius ?? h / 2, h / 2));
    ctx.fillStyle = brand.blue;
    ctx.fill();

    const textK = clamp01((t - s.pillGrow * 0.7) / s.pillTextIn);
    if (textK > 0) {
      ctx.save();
      ctx.globalAlpha = alpha * textK;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(badge, x + s.pillPadX, y + s.pillHeight * 0.5 + s.pillFontSize * 0.36);
      ctx.restore();
    }

    y += s.pillHeight + s.pillGap;
  }

  // The badge's wider word-space is for the badge alone — the headline is set
  // in a display face at four times the size and needs no help separating.
  ctx.wordSpacing = '0px';
  ctx.font = `${s.headlineWeight} ${layout.size}px "${s.headFont}"`;

  let word = 0;
  const startAt = badge ? s.pillGrow * 0.8 : 0;

  for (const line of layout.lines) {
    const baseline = y + layout.size * 0.78;
    for (const run of line.runs) {
      // Reveal by word, not by character: a character wipe on a display face
      // shows half-formed letterforms, which looks like a rendering fault.
      for (const piece of splitWords(run.text)) {
        const k = easeOutCubic((t - startAt - word * s.wordStagger) / s.wordIn);
        if (piece.text.trim()) word++;
        if (k <= 0) continue;

        ctx.save();
        ctx.globalAlpha = alpha * k;
        ctx.fillStyle = run.hot ? brand.blue : s.ink;
        // Condensed horizontally, which means every x measured unscaled has to
        // be divided back out — the transform will multiply it again.
        ctx.scale(sx, 1);
        // A short rise as each word lands, so the line assembles rather than
        // blinking on.
        // The left margin is a screen position and must not be squeezed with
        // the type, so only the run's own offset rides the scale.
        ctx.fillText(
          piece.text,
          x / sx + run.x + piece.x,
          baseline + (1 - k) * layout.size * 0.14,
        );
        ctx.restore();
      }
    }
    y += layout.leading;
  }

  ctx.restore();

  function splitWords(text) {
    const parts = text.split(/(\s+)/).filter((p) => p !== '');
    const out = [];
    let at = 0;
    for (const p of parts) {
      out.push({ text: p, x: at });
      at += ctx.measureText(p).width;
    }
    return out;
  }
}

/** The closing lockup: the finished logo, no build. */
export function drawClosing(ctx, { art, style, width, height, alpha = 1, scale = 1 }) {
  if (alpha <= 0) return;
  const s = style;

  const logoH = s.lockupHeight;
  const logoW = (art.logo.width / art.logo.height) * logoH;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = `${s.wordTracking}px`;
  ctx.font = `${s.wordWeight} ${Math.round(logoH * s.wordSize)}px "${s.wordFont}"`;

  const word = s.word ?? '';
  const wordAt = logoW + s.dividerGap + s.dividerWidth + s.wordGap;
  const fullW = word ? wordAt + ctx.measureText(word).width : logoW;

  ctx.translate(width / 2, height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-width / 2, -height / 2);

  const x = (width - fullW) / 2;
  const y = (height - logoH) / 2;

  ctx.drawImage(art.logo, x, y, logoW, logoH);

  if (word) {
    ctx.fillStyle = s.wordColor;
    const h = logoH * s.dividerHeight;
    ctx.fillRect(x + logoW + s.dividerGap, y + (logoH - h) / 2, s.dividerWidth, h);
    ctx.fillText(word, x + wordAt, y + logoH * s.wordBaseline);
  }

  ctx.letterSpacing = '0px';
  ctx.restore();
}

// ---- list sections ----
//
// The layout the examples use when the narrator enumerates: the recording
// shrinks into a window on the right, and the copy stands beside it — logo,
// headline, then a checklist that lands one point at a time.
//
// Everything is measured off "[T1] 4.2" at 28s-48s. The one thing that is not
// obvious from looking at it: the recording inside the smaller window is at
// exactly the same magnification as before, anchored to its left edge. It is a
// crop, not a shrink — which is why the interface stays readable at a third of
// the width instead of turning into a thumbnail.

export function layoutList(ctx, { headline, highlight, items, style, width }) {
  const maxWidth = style.window.x - style.marginX - 70;

  let size = style.headlineSize;
  let lines;
  for (;;) {
    ctx.font = `${style.headlineWeight} ${size}px "${style.headFont}"`;
    lines = balance(ctx, wrap(ctx, headline, maxWidth));
    if (lines.length <= 2 || size <= 44) break;
    size = Math.round(size * 0.92);
  }

  const laid = lines.map((line) => {
    const runs = splitHighlights(line, highlight);
    let x = 0;
    for (const r of runs) {
      r.x = x;
      r.w = ctx.measureText(r.text).width;
      x += r.w;
    }
    return { runs };
  });

  // Points are labels, not paragraphs; a long one shrinks rather than wraps,
  // because a wrapped bullet next to unwrapped ones reads as a mistake.
  const textLeft = style.marginX + style.boxSize + style.boxGap;
  const room = width - textLeft - 60 - (width - style.window.x);
  let itemSize = style.itemSize;
  for (;;) {
    ctx.font = `${style.itemWeight} ${itemSize}px "${style.bodyFont}"`;
    if (itemSize <= 26 || items.every((s) => ctx.measureText(s).width <= room)) break;
    itemSize -= 2;
  }

  return { lines: laid, headlineSize: size, items, itemSize, textLeft };
}

function drawCheck(ctx, x, y, size, radius, colour, k) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, radius);
  ctx.fillStyle = colour;
  ctx.fill();

  // The tick draws itself on, which is most of why the point reads as landing
  // rather than appearing.
  const p = Math.min(1, Math.max(0, (k - 0.25) / 0.6));
  if (p > 0) {
    const s = size;
    const a = { x: x + s * 0.26, y: y + s * 0.52 };
    const b = { x: x + s * 0.43, y: y + s * 0.68 };
    const c = { x: x + s * 0.75, y: y + s * 0.33 };
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    const first = Math.min(1, p / 0.4);
    ctx.lineTo(a.x + (b.x - a.x) * first, a.y + (b.y - a.y) * first);
    if (p > 0.4) {
      const second = (p - 0.4) / 0.6;
      ctx.lineTo(b.x + (c.x - b.x) * second, b.y + (c.y - b.y) * second);
    }
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(3, size * 0.11);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  ctx.restore();
}

export function drawList(ctx, t, { layout, art, style, brand, width, alpha = 1 }) {
  if (alpha <= 0) return;
  const s = style;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic';

  // logo
  const logoK = easeOutCubic(t / s.logoIn);
  if (logoK > 0) {
    const h = s.logoHeight;
    const w = (art.logo.width / art.logo.height) * h;
    ctx.save();
    ctx.globalAlpha = alpha * logoK;
    ctx.drawImage(art.logo, s.marginX, s.logoTop + (1 - logoK) * 14, w, h);
    ctx.restore();
  }

  // headline, revealed a word at a time like the title card
  ctx.font = `${s.headlineWeight} ${layout.headlineSize}px "${s.headFont}"`;
  const leading = Math.round(layout.headlineSize * 1.06);
  let y = s.headlineTop + layout.headlineSize * 0.76;
  let word = 0;

  for (const line of layout.lines) {
    for (const run of line.runs) {
      const parts = run.text.split(/(\s+)/).filter((p) => p !== '');
      let dx = 0;
      for (const piece of parts) {
        const k = easeOutCubic((t - s.logoIn * 0.6 - word * 0.07) / s.headlineIn);
        if (piece.trim()) word++;
        if (k > 0) {
          ctx.save();
          ctx.globalAlpha = alpha * k;
          ctx.fillStyle = run.hot ? brand.blue : s.ink;
          ctx.fillText(piece, s.marginX + run.x + dx, y + (1 - k) * layout.headlineSize * 0.14);
          ctx.restore();
        }
        dx += ctx.measureText(piece).width;
      }
    }
    y += leading;
  }

  // points
  ctx.font = `${s.itemWeight} ${layout.itemSize}px "${s.bodyFont}"`;
  layout.items.forEach((text, i) => {
    const k = easeOutCubic((t - s.itemsStart - i * s.itemStagger) / s.itemIn);
    if (k <= 0) return;
    const top = s.itemsTop + i * s.itemStride;
    const rise = (1 - k) * 18;

    ctx.save();
    ctx.globalAlpha = alpha * k;
    drawCheck(ctx, s.marginX, top + rise, s.boxSize, s.boxRadius, brand.blue, k);
    ctx.fillStyle = s.ink;
    ctx.fillText(text, layout.textLeft, top + rise + s.boxSize * 0.5 + layout.itemSize * 0.36);
    ctx.restore();
  });

  ctx.restore();
}
