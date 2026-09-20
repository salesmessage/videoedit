// Where everything lives.
//
// One module knows the layout, so moving a folder is one edit rather than a
// search. Each location can be pointed elsewhere with an environment variable,
// which is what makes the brand swappable: a second brand is a second folder
// with the same shape, not a fork of the code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

const at = (envVar, ...rel) =>
  process.env[envVar] ? path.resolve(process.env[envVar]) : path.join(ROOT, ...rel);

/** Drop a take here. */
export const INBOX = at('VIDEOEDIT_IN', 'in');
/** Finished lessons land here. */
export const OUTBOX = at('VIDEOEDIT_OUT', 'out');
/** Logo, type, colour, sounds — everything the look is made of. */
export const BRAND = at('VIDEOEDIT_BRAND', 'brand');
/** Speech models, downloaded once. */
export const MODELS = at('VIDEOEDIT_MODELS', 'models');
/** Hand-finished lessons the look was measured against. Not used at runtime. */
export const REFERENCE = path.join(ROOT, 'reference');

/** Intermediates. Safe to delete at any time. */
export const WORK = path.join(ROOT, '.work');
/** Rendered speech, keyed by content. Deleting it costs money, not correctness. */
export const CACHE = path.join(ROOT, '.cache');

export const brandFile = (...rel) => path.join(BRAND, ...rel);

export function ensureDirs() {
  for (const d of [INBOX, OUTBOX, WORK, CACHE]) fs.mkdirSync(d, { recursive: true });
}

/**
 * How a take is recognised and what its result is called.
 *
 * "Connecting Salesforce Source.mp4" in the inbox becomes
 * "Connecting Salesforce Output.mp4" in the outbox. The suffixes are the whole
 * convention: they are what lets a folder be scanned for work without a
 * database of what has already been done.
 */
export const SOURCE_SUFFIX = process.env.VIDEOEDIT_SOURCE_SUFFIX ?? 'Source';
export const OUTPUT_SUFFIX = process.env.VIDEOEDIT_OUTPUT_SUFFIX ?? 'Output';

const VIDEO = /\.(mp4|mov|mkv|webm|m4v)$/i;

export const isTake = (name) =>
  VIDEO.test(name) && new RegExp(`\\s${SOURCE_SUFFIX}\\s*$`, 'i').test(name.replace(VIDEO, ''));

/** The stem of a take, with the " Source" marker removed. */
export const stemOf = (file) =>
  path.basename(file)
    .replace(VIDEO, '')
    .replace(new RegExp(`\\s+${SOURCE_SUFFIX}\\s*$`, 'i'), '')
    .trim();

export const outputFor = (file, outbox = OUTBOX) =>
  path.join(outbox, `${stemOf(file)} ${OUTPUT_SUFFIX}.mp4`);

/** Per-video overrides sit beside the take, named after it. */
export function sidecarFor(file) {
  const stem = file.replace(VIDEO, '');
  const candidates = [`${stem}.json`, path.join(path.dirname(file), 'video.json')];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Takes in the inbox that have no finished lesson yet. */
export function pendingTakes({ inbox = INBOX, outbox = OUTBOX, force = false } = {}) {
  if (!fs.existsSync(inbox)) return [];
  return fs
    .readdirSync(inbox)
    .filter(isTake)
    .map((name) => path.join(inbox, name))
    .filter((file) => force || !fs.existsSync(outputFor(file, outbox)))
    .sort();
}

/** A filename-safe version of a stem, for intermediates. */
export const slug = (s) =>
  s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
