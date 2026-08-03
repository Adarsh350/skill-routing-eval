import { test } from "node:test";
import assert from "node:assert/strict";
import { collapse, summarize, verdictFor } from "../eval/score.mjs";

const samples = (id, on, hits, n) =>
  Array.from({ length: n }, (_, i) => ({ id, on, hit: i < hits }));

test("majority of samples decides the verdict", () => {
  const byId = collapse(samples("a", true, 2, 3));
  assert.equal(byId.a.on.hit, true, "2 of 3 is a hit");

  const byId2 = collapse(samples("b", true, 1, 3));
  assert.equal(byId2.b.on.hit, false, "1 of 3 is a miss");
});

test("an even split is a miss, not a hit", () => {
  const byId = collapse(samples("a", true, 1, 2));
  assert.equal(byId.a.on.hit, false, "a coin flip must not score as a pass");
});

test("partial agreement is reported as flaky", () => {
  const byId = collapse([...samples("a", true, 2, 3), ...samples("b", true, 3, 3)]);
  assert.equal(byId.a.on.flaky, true, "2/3 is flaky");
  assert.equal(byId.b.on.flaky, false, "3/3 is stable");
});

test("arms are counted independently", () => {
  const byId = collapse([...samples("a", true, 3, 3), ...samples("a", false, 0, 3)]);
  assert.equal(byId.a.on.hit, true);
  assert.equal(byId.a.off.hit, false);
});

test("verdict credits the injection only when the OFF arm fails", () => {
  const hit = { hit: true };
  const miss = { hit: false };
  assert.equal(verdictFor(hit, miss), "earned");
  assert.equal(verdictFor(hit, hit), "tie", "both arms passing means the map was not needed");
  assert.equal(verdictFor(miss, hit), "hurt");
  assert.equal(verdictFor(miss, miss), "both-miss");
});

test("verdict is undefined when only one arm ran", () => {
  assert.equal(verdictFor({ hit: true }, undefined), null);
});

test("delta is the difference in pass rate between arms", () => {
  const raw = [
    ...samples("a", true, 3, 3),
    ...samples("a", false, 0, 3),
    ...samples("b", true, 3, 3),
    ...samples("b", false, 3, 3),
  ];
  const { onHits, offHits, deltaPct } = summarize(collapse(raw));
  assert.equal(onHits, 2);
  assert.equal(offHits, 1);
  assert.equal(deltaPct, 50);
});

test("delta is null when only one arm ran", () => {
  const { deltaPct } = summarize(collapse(samples("a", true, 3, 3)));
  assert.equal(deltaPct, null, "a single-arm run has nothing to compare against");
});
