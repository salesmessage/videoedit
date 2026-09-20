// The brand, read from one place.
//
// brand/StyleGuide.txt is the source of truth for colour and type, and the rest
// of brand/ holds the logo art, the fonts, the transition cues and the bed.
// Every stage that paints or plays anything imports this, so the style-guide hex
// cannot end up in the title card and not in the mat behind the recording.
//
// The whole folder is swappable: point VIDEOEDIT_BRAND at another one with the
// same shape and nothing in the code changes.

import fs from 'node:fs';
import path from 'node:path';
import { GlobalFonts, loadImage, createCanvas } from '@napi-rs/canvas';
import { BRAND, ROOT, brandFile } from './paths.mjs';

export { ROOT };
export const BRAND_DIR = BRAND;

// Used only for lines the style guide does not carry — these mirror the file.
const DEFAULTS = {
  blue: '#1d94ef',
  green: '#13cb6e',
  headlineFont: 'Neue Einstellung',
  bodyFont: 'Inter',
};

export function readStyleGuide(dir = BRAND) {
  const style = { ...DEFAULTS };
  const file = path.join(dir, 'StyleGuide.txt');

  if (!fs.existsSync(file)) {
    console.warn(`warning: ${file} not found — using built-in brand defaults`);
    return style;
  }

  // Lines are "Label: value"; labels are matched on what they say rather than
  // on exact wording, so the file stays human-editable.
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([^:]+):(.*)$/.exec(raw.trim());
    if (!m) continue;
    const label = m[1].toLowerCase();
    const value = m[2].trim();
    if (!value) continue;

    if (/blue/.test(label)) style.blue = value;
    else if (/green/.test(label)) style.green = value;
    else if (/headline|display|heading/.test(label)) style.headlineFont = value;
    else if (/body|text/.test(label)) style.bodyFont = value;
  }

  return style;
}

// ---- fonts ----
// Drop a .ttf/.otf anywhere under brand/fonts and the style-guide names resolve
// to it. Falling back is loud: a card set in the wrong typeface is the kind of
// mistake that ships because nothing complained.

export function registerBrandFonts(dir = BRAND) {
  const loaded = [];
  const walk = (d, depth = 0) => {
    if (depth > 3 || !fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (/\.(ttf|otf)$/i.test(entry.name) && GlobalFonts.registerFromPath(p)) {
        loaded.push(entry.name);
      }
    }
  };
  walk(path.join(dir, 'fonts'));
  walk(dir, 3); // loose font files sitting next to the logos
  return loaded;
}

export function resolveFont(want, role) {
  if (GlobalFonts.has(want)) return want;
  const alt =
    ['Segoe UI', 'Helvetica Neue', 'Arial', 'DejaVu Sans'].find((f) => GlobalFonts.has(f)) ??
    'sans-serif';
  console.warn(
    `warning: ${role} font "${want}" is not installed and is not in ` +
      `${path.relative(process.cwd(), BRAND)}/fonts — falling back to ${alt}.`,
  );
  return alt;
}

// ---- art ----
// The lockup art. `logo.png` is the name the code looks for; the brand folder
// keeps the real filenames too, and either resolves.
const firstThatExists = (...names) =>
  names.map((n) => brandFile('logo', n)).find((p) => fs.existsSync(p)) ?? brandFile('logo', names[0]);

export const LOGO_BLUE = firstThatExists('logo.png', 'salesmsg-logo-blue.png');
export const LOGO_WHITE = firstThatExists('logo-white.png', 'salesmsg-logo-white.png');

/**
 * The logo art, plus where the speech-bubble mark sits inside it.
 *
 * The opening animates the mark alone before the wordmark arrives, and the
 * obvious way to do that — draw the separate icon PNG, then draw the logo over
 * it — puts two marks on screen at once the moment the logo appears, because
 * the two files do not agree on the mark's proportions. Cropping the mark out
 * of the logo itself removes the disagreement: there is one piece of art, and
 * the wordmark reveal is a clip widening across it.
 *
 * The mark's extent is found from the art rather than hard-coded, so a
 * redrawn logo does not silently mis-crop.
 */
export async function loadArt() {
  const logo = await loadImage(LOGO_BLUE);

  const probe = createCanvas(logo.width, logo.height);
  const pctx = probe.getContext('2d');
  pctx.drawImage(logo, 0, 0);
  const { data } = pctx.getImageData(0, 0, logo.width, logo.height);

  // Every inked column run in the art. The first is the speech-bubble mark and
  // the rest are the eight letters of the wordmark — which is what lets the
  // opening animate them apart and closed again instead of wiping across them.
  const inked = new Uint8Array(logo.width);
  for (let x = 0; x < logo.width; x++) {
    for (let y = 0; y < logo.height; y++) {
      if (data[(y * logo.width + x) * 4 + 3] > 16) { inked[x] = 1; break; }
    }
  }

  const glyphs = [];
  for (let x = 0; x < logo.width; x++) {
    if (!inked[x]) continue;
    let end = x;
    while (end < logo.width && inked[end]) end++;
    glyphs.push({ x, w: end - x });
    x = end;
  }

  if (!glyphs.length) throw new Error(`${LOGO_BLUE} has no visible ink`);

  return { logo, markBox: { ...glyphs[0], y: 0, h: logo.height }, glyphs };
}

// ---- colour maths ----
export const rgbOf = (hex) => {
  const h = hex.replace('#', '').trim();
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export const hexOf = (rgb) =>
  '#' + rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('');

export const mix = (a, b, t) => hexOf(rgbOf(a).map((c, i) => c + (rgbOf(b)[i] - c) * t));

/** A lighter relative of a hex that keeps its hue — the mat is made of these. */
export const tint = (hex, t) => mix(hex, '#ffffff', t);

/** A darker relative that keeps its hue, rather than sliding into navy. */
export const shade = (hex, t) => mix(hex, '#062744', t);

export const rgba = (hex, a) => {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r},${g},${b},${a})`;
};
