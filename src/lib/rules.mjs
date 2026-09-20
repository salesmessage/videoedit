// The house rules — the editorial requirements a finished lesson has to meet,
// as opposed to the numbers that describe how it looks.
//
// `config.mjs` holds constants: how wide the mat is, how deep a zoom goes. Those
// are measurements, and a take that lands outside one of them is still a valid
// lesson. What lives here is different in kind: a condition on the *edit* that
// is true of every lesson in this library by decision, not by measurement. A
// take that fails one has not been styled wrongly — it is unfinished.
//
// They are checked at plan time, before the render, because that is where the
// remedy is cheap: the fix is a line in the sidecar, and finding out after a
// four-minute encode that a section is missing wastes the encode.
//
// Each rule carries its own `why` and `remedy` and they are written to be read
// off the terminal by whoever has to act on them. The verdicts go into the plan
// report as well, so a finished lesson has a record of which rules it was held
// to and what they saw — see `evaluate` and the `rules` block of the plan JSON.

/**
 * Every lesson carries at least one list section.
 *
 * The section card is part of the house style rather than an opportunistic
 * flourish, and `detectSections` cannot be relied on to supply it: detection is
 * deliberately narrow — a counted lead-in ("three options…") or the "there's A,
 * B and C" construction, and nothing else — because a false positive is a
 * full-screen graphic asserting a list nobody gave. That narrowness is right
 * for the detector and it means a narrator who enumerates across three
 * sentences with no count gets nothing, which is a gap in the deliverable, not
 * a correct read of the take.
 *
 * So when detection finds none, one is written by hand. This rule is what makes
 * that a step rather than an afterthought.
 */
const requireSection = {
  id: 'require-section',
  what: 'at least one list section',
  why: 'the section card is part of the house style; narrow detection is not a licence to ship without one',
  remedy: 'read the transcript for the passage where the narrator enumerates, and write a '
    + 'section over it in the sidecar: sections: [{ start, end, headline, highlight, items }]. '
    + 'Times are on the take\'s clock. Accept that it blanks any zoom underneath it.',
  enabled: (cfg) => cfg.rules?.requireSection !== false,
  check: ({ sections, drafted }) => ({
    satisfied: sections.length > 0,
    detail: sections.length
      ? `${sections.length} section(s) (${drafted} drafted by detection)`
      : 'none — detection drafted nothing and the sidecar supplies nothing',
  }),
};

/**
 * A section's crop anchor is a deliberate choice.
 *
 * Inside a section the recording is cropped, not shrunk, so a third of the
 * width is all that survives and which third is the whole question. `focusOf`
 * picks it by motion salience, which is the right default and is wrong in one
 * recurring case: an app whose subject sits in a left-hand panel while the
 * cursor wanders the empty canvas to its right pulls the anchor into the middle
 * and slices the panel in half.
 *
 * This does not fail a plan — a computed anchor is usually correct. It reports
 * the anchor it is about to use so that it is looked at, because the cost of
 * not looking is a section card whose recording shows none of what is being
 * discussed, and that is only visible after the render.
 */
const declareFocus = {
  id: 'declare-section-focus',
  what: 'each section\'s crop anchor is reviewed',
  why: 'the section crops rather than shrinks, so a computed anchor can cut away the panel the section is about',
  remedy: 'check the anchor against a frame from the middle of the section. Set focusX on the '
    + 'section (0 = left edge, 1 = right) when the subject is in a side panel — left is the '
    + 'reference lessons\' own choice.',
  advisory: true,
  enabled: (cfg) => cfg.rules?.declareFocus !== false,
  check: ({ sections }) => ({
    satisfied: sections.every((s) => s.focusExplicit),
    detail: sections.length
      ? sections
        .map((s) => `${s.start.toFixed(1)}s anchor ${(s.focusX ?? 0).toFixed(2)}`
          + (s.focusExplicit ? ' (set)' : ' (computed)'))
        .join(', ')
      : 'no sections',
  }),
};

export const RULES = [requireSection, declareFocus];

/**
 * Hold a plan against the rules. Returns one verdict per enabled rule, in the
 * order they are declared, plus whether anything that can fail did.
 *
 * `strict` promotes a broken rule from a warning to a stopped run. It is off by
 * default: a rule is a statement about the finished lesson and the person
 * running the pipeline is allowed to be somewhere in the middle of getting
 * there. Turn it on (`rules.strict`) for a batch nobody is watching.
 */
export function evaluate(plan, cfg = {}) {
  const verdicts = [];
  for (const rule of RULES) {
    if (rule.enabled && !rule.enabled(cfg)) continue;
    const { satisfied, detail } = rule.check(plan);
    verdicts.push({
      id: rule.id,
      what: rule.what,
      why: rule.why,
      advisory: Boolean(rule.advisory),
      satisfied,
      detail,
      ...(satisfied ? {} : { remedy: rule.remedy }),
    });
  }
  const broken = verdicts.filter((v) => !v.satisfied && !v.advisory);
  return { verdicts, broken, strict: Boolean(cfg.rules?.strict) };
}

/**
 * Print the verdicts in the shape the rest of the plan output uses, and stop the
 * run when a rule is broken under `rules.strict`.
 */
export function reportRules(plan, cfg = {}) {
  const result = evaluate(plan, cfg);
  for (const v of result.verdicts) {
    const mark = v.satisfied ? 'ok  ' : (v.advisory ? 'note' : 'FAIL');
    console.log(`rules : ${mark} ${v.what} — ${v.detail}`);
    if (!v.satisfied) console.log(`        why: ${v.why}`);
    if (!v.satisfied) console.log(`        fix: ${v.remedy}`);
  }
  if (result.broken.length && result.strict) {
    throw new Error(
      `${result.broken.length} house rule(s) broken and rules.strict is on: `
      + result.broken.map((v) => v.id).join(', '),
    );
  }
  return result;
}
