// score.mjs — the scoring rules, kept separate from the code that spawns agents.
//
// Splitting these out is what makes the eval testable at all: every interesting decision
// (how samples collapse, what counts as flaky, which arm gets credit) is a pure function
// of the raw results, so it can be exercised without a single model call.

/**
 * Collapse repeated samples into one verdict per (fixture, arm).
 *
 * Majority vote, not any-hit and not all-hit. Any-hit inflates the score of a model that
 * gets there one time in five; all-hit reports a regression the first time an otherwise
 * reliable fixture blinks. Majority tracks "would this usually work", which is the thing
 * you actually care about.
 *
 * @param {Array<{id: string, on: boolean, hit: boolean}>} raw
 * @returns {Record<string, {on?: Cell, off?: Cell}>}
 */
export function collapse(raw) {
  const byId = {};
  for (const r of raw) {
    const arm = r.on ? "on" : "off";
    const cell = ((byId[r.id] ??= {})[arm] ??= { hits: 0, n: 0 });
    cell.n++;
    if (r.hit) cell.hits++;
  }

  for (const id of Object.keys(byId)) {
    for (const arm of Object.keys(byId[id])) {
      const c = byId[id][arm];
      // Strict majority: a 1/2 tie is not a hit. With an even sample count, "half the time"
      // is a coin flip, and scoring a coin flip as a pass is how an eval starts lying.
      c.hit = c.hits * 2 > c.n;
      c.flaky = c.hits > 0 && c.hits < c.n;
    }
  }
  return byId;
}

/**
 * Per-fixture verdict comparing the two arms.
 *
 * `earned` is the only category that justifies the injection's token cost. A pile of
 * `tie` rows means the model routes correctly without the map and you are paying for
 * nothing — that finding is the entire point of running the OFF arm.
 */
export function verdictFor(on, off) {
  if (!on || !off) return null;
  if (on.hit && !off.hit) return "earned";
  if (!on.hit && off.hit) return "hurt";
  if (!on.hit && !off.hit) return "both-miss";
  return "tie";
}

/** Aggregate totals and the ON-minus-OFF delta in percentage points. */
export function summarize(byId) {
  let onHits = 0;
  let offHits = 0;
  let onTotal = 0;
  let offTotal = 0;

  for (const id of Object.keys(byId)) {
    const { on, off } = byId[id];
    if (on) {
      onTotal++;
      if (on.hit) onHits++;
    }
    if (off) {
      offTotal++;
      if (off.hit) offHits++;
    }
  }

  const deltaPct =
    onTotal && offTotal ? (onHits / onTotal - offHits / offTotal) * 100 : null;

  return { onHits, onTotal, offHits, offTotal, deltaPct };
}
