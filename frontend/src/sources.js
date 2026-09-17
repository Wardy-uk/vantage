/**
 * Where a radar card came from, grouped and coloured.
 *
 * ── Why grouping first, colour second ───────────────────────────────────────
 *
 * The radar carries ten distinct `source` strings — NOVA, NOVA + NEURO, People,
 * 1:1 coverage, 1:1 booking, NEURO, Meetings, Sentiment, Support Review,
 * Leading. Ten categorical colours is past the point where anyone can hold the
 * mapping in their head, and the rule is that a ninth hue is never generated:
 * it folds into a group or the encoding stops working.
 *
 * So these are six FAMILIES, and the grouping is not cosmetic — it answers the
 * question the colour is there to answer. "Which system claims this, and what
 * kind of judgement produced it": a counted fact from the ticket system, a
 * statistical inference, a model reading a transcript, a fact about people.
 *
 * ── Two colour dimensions, kept apart ───────────────────────────────────────
 *
 * ⚠ Severity is ALREADY colour on this screen — the red/amber/grey dot at the
 * left of every card. Painting the source in saturated colour too would put two
 * colour scales in one visual field, and the reader would have to learn which
 * one meant danger.
 *
 * So severity keeps the saturated status colours and stays the loud one. Source
 * colour is carried on the PILL only, as a tinted border and text on a
 * transparent ground — present enough to group by, quiet enough never to
 * compete with a red dot. The one place source colour is allowed to be solid is
 * the count strip, where no severity is shown and the colour is doing the whole
 * job.
 *
 * ── The palette is validated, not chosen ────────────────────────────────────
 *
 * Six slots from the reference categorical palette, dark-mode steps, checked
 * with `validate_palette.js` against this app's panel surface (#161b22):
 * lightness band PASS, chroma floor PASS, CVD separation PASS (worst adjacent
 * ΔE 8.4, protan), normal-vision floor PASS (19.3), contrast PASS (all ≥ 3:1).
 *
 * Every pill also carries its family NAME, so identity is never colour alone —
 * which is what makes the 8.4 comfortable rather than marginal.
 *
 * Deliberately distinct from `--good` / `--warn` / `--bad`: status colours are
 * reserved, and reusing one here would make a source look like a state.
 */

/** Fixed order. A slot belongs to a family for good — it never shifts when a
 *  filter changes which families are on screen. */
export const FAMILIES = [
  {
    key: 'leading',
    label: 'Leading',
    colour: '#3987e5',
    blurb: 'Statistical detectors. The only cards with a lead time and a verdict.',
  },
  {
    key: 'nova',
    label: 'NOVA',
    colour: '#199e70',
    blurb: 'Counted facts from the ticket system — breaches, stalls, unowned work.',
  },
  {
    key: 'neuro',
    label: 'People',
    colour: '#d55181',
    blurb: 'NEURO: 1:1 cadence and booking, team health, your own commitments.',
  },
  {
    key: 'meetings',
    label: 'Meetings',
    colour: '#9085e9',
    blurb: 'A model reading recent meeting notes for risk nobody logged. The least validated source here.',
  },
  {
    key: 'sentiment',
    label: 'Sentiment',
    colour: '#d95926',
    blurb: 'How the work is landing with customers.',
  },
  {
    key: 'plan',
    label: 'Plan',
    colour: '#c98500',
    blurb: 'The Support Review improvement plan.',
  },
];

/** Anything unrecognised. Grey, named, never a generated hue. */
export const OTHER = { key: 'other', label: 'Other', colour: '#8b98a8', blurb: 'A source this screen has not been taught to group.' };

const BY_SOURCE = {
  Leading: 'leading',
  NOVA: 'nova',
  'NOVA + NEURO': 'nova',
  NEURO: 'neuro',
  People: 'neuro',
  '1:1 coverage': 'neuro',
  '1:1 booking': 'neuro',
  Conversations: 'neuro',
  Meetings: 'meetings',
  Sentiment: 'sentiment',
  'Support Review': 'plan',
};

export function familyFor(source) {
  const key = BY_SOURCE[source];
  return FAMILIES.find(f => f.key === key) || OTHER;
}

/**
 * Counts per family, in the fixed slot order, INCLUDING the empty ones.
 *
 * ⚠ The first cut dropped zero families, reasoning that a row of zeroes reads
 * as "nothing is wrong there" when it means "nothing came from there today".
 * Nick asked for the zeroes and he is right, for a reason specific to this
 * reader: he knows what the six families are, so `Leading 0` tells him the
 * detectors are QUIET — which is different from, and much better than, the
 * strip silently not mentioning them. A row that changes shape day to day
 * cannot be read at a glance; a fixed one can, and the positions become
 * learnable.
 *
 * `Other` is the exception and still only appears when it has something in it.
 * An always-present "Other 0" would be a permanent slot for a bug that is not
 * currently happening.
 */
export function countByFamily(items = []) {
  const counts = new Map();
  for (const it of items) {
    const f = familyFor(it.source);
    counts.set(f.key, (counts.get(f.key) || 0) + 1);
  }
  return [...FAMILIES, OTHER]
    .filter(f => f.key !== 'other' || counts.get(f.key))
    .map(f => ({ ...f, count: counts.get(f.key) || 0 }));
}
