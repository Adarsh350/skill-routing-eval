#!/usr/bin/env node
// run.mjs — A/B eval for a context injection.
//
// The question this answers: does the text you inject into every agent session actually
// change what the agent does, or are you paying tokens for a placebo?
//
// The design that makes it answerable is the OFF arm. Running only the ON arm tells you
// the agent scored 15/15, which feels like proof and isn't — a capable model may already
// route correctly from names alone. The delta between arms is the only number that
// attributes the outcome to the injection.
//
// The injection is toggled by an environment variable that your hook reads. The hook must
// exit early when it is set:
//
//   if (process.env.EVAL_INJECTION_OFF === "1") process.exit(0);
//
// Usage:
//   node eval/run.mjs
//   node eval/run.mjs --model haiku --repeat 5
//   node eval/run.mjs --arm on --limit 3      (partial runs never touch history)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { collapse, summarize, verdictFor } from "./score.mjs";

const args = process.argv.slice(2);
const argVal = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : d;
};

const model = argVal("--model", "opus");
const fixturesPath = argVal("--fixtures", path.join("eval", "fixtures.jsonl"));
const historyPath = argVal("--history", path.join("eval", `history-${model}.jsonl`));
const limit = Number(argVal("--limit")) || Infinity;
const armFilter = argVal("--arm");
const repeat = Math.max(1, Number(argVal("--repeat")) || 3);
const timeoutMs = Number(argVal("--timeout")) || 240_000;

// Deliberately low. Agent CLIs are slow and rate-limited; oversubscribing turns real
// results into timeouts, which score as misses and quietly corrupt the run.
const concurrency = Number(argVal("--concurrency")) || 4;

const OFF_ENV = argVal("--off-env", "EVAL_INJECTION_OFF");

const fixtures = fs
  .readFileSync(fixturesPath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .slice(0, limit);

if (!fixtures.length) {
  console.error(`No fixtures in ${fixturesPath}`);
  process.exit(1);
}

// A timeout resolves rather than rejects: one hung call should cost one fixture, not the run.
function ask(prompt, injectionOn) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (!injectionOn) env[OFF_ENV] = "1";

    const child = spawn("claude", ["--model", model, "-p"], { env, shell: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("<TIMEOUT>");
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("<SPAWN-ERROR>");
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const isHit = (response, fixture) => new RegExp(fixture.expect, "i").test(response);

async function pool(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const arms = armFilter === "on" ? [true] : armFilter === "off" ? [false] : [true, false];

// Every (fixture, arm) pair is sampled `repeat` times and collapsed by majority vote.
// Single-sample evals on a nondeterministic model measure sampling noise, not the injection:
// one lucky response flips a fixture and a 1-point "regression" sends you debugging nothing.
const jobs = fixtures.flatMap((fx) =>
  arms.flatMap((on) => Array.from({ length: repeat }, () => ({ fx, on })))
);

console.log(
  `Model: ${model} | ${jobs.length} calls ` +
    `(${fixtures.length} fixtures x ${arms.length} arm(s) x ${repeat} samples)\n`
);

const startedAt = Date.now();
const raw = await pool(jobs, async ({ fx, on }) => ({
  id: fx.id,
  on,
  hit: isHit(await ask(fx.prompt, on), fx),
}));

const byId = collapse(raw);

const LABEL = {
  earned: "<- injection earned this",
  hurt: "<- injection HURT this",
  "both-miss": "<- both miss",
  tie: "<- tie (routed fine without it)",
};

const rows = fixtures.map((fx) => {
  const on = byId[fx.id]?.on;
  const off = byId[fx.id]?.off;
  const mark = (r) => (!r ? "  -  " : `${r.hit ? " HIT" : "MISS"} ${r.hits}/${r.n}`);
  // Split samples are the fixtures worth rewriting: the prompt is ambiguous, not the map.
  const flaky = on?.flaky || off?.flaky ? " [FLAKY]" : "";
  return `  ${fx.id.padEnd(22)} on:${mark(on)}  off:${mark(off)}  ${
    LABEL[verdictFor(on, off)] ?? ""
  }${flaky}`;
});

const { onHits, onTotal, offHits, offTotal, deltaPct } = summarize(byId);

console.log(rows.join("\n"));
console.log(`\nInjection ON : ${onHits}/${onTotal}`);
if (offTotal) console.log(`Injection OFF: ${offHits}/${offTotal}`);
if (deltaPct !== null) console.log(`Delta        : ${deltaPct.toFixed(0)} percentage points`);
console.log(`Elapsed      : ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

// A partial run appended to history reads as a full run later. A 2/2 entry next to a
// 15/15 entry looks like a collapse in coverage and there is nothing in the row to say
// otherwise, so partial runs are reported and discarded.
if (limit !== Infinity || armFilter) {
  console.log("\n(partial run - history not written)");
  process.exit(0);
}

const perFixture = {};
for (const fx of fixtures) {
  perFixture[fx.id] = { on: byId[fx.id]?.on?.hit ?? null, off: byId[fx.id]?.off?.hit ?? null };
}

fs.appendFileSync(
  historyPath,
  JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    model,
    repeat,
    onHits,
    onTotal,
    offHits,
    offTotal,
    perFixture,
  }) + "\n"
);

console.log(`\nWritten to ${historyPath}`);
