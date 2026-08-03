# skill-routing-eval

An A/B harness for measuring whether the text you inject into every agent session actually
changes what the agent does.

If you run Claude Code with more than a handful of skills, you have probably written
something like a routing map — a block of "use X when Y, not Z" that a `SessionStart` hook
prepends to every session. The obvious question is whether it works. The tempting way to
answer it is to inject the map, try a few prompts, watch the agent pick correctly, and
conclude that it does.

That is not evidence. A capable model may already route correctly from skill names alone,
in which case the map costs tokens in every session forever and buys nothing. You cannot
tell those two worlds apart by looking at one arm.

So this harness runs both. Same fixtures, injection on and off, and reports the delta.

## Why the map exists at all

Claude Code's session listing gives personal and plugin skills by **name only** —
descriptions are not in context at the moment a skill gets selected. So a skill whose name
doesn't announce its own trigger is effectively unroutable no matter how good its
description is. `output-discipline` and `mem-search` are invisible in a way that
`pricing-strategy` is not.

That is a real gap, and a routing map is a reasonable patch for it. Whether *your* map
closes it is an empirical question, which is what the rest of this repo is for.

## Results from my own setup

15 fixtures, 3 samples per cell, majority vote:

| Model | Injection ON | Injection OFF | Delta |
|---|---|---|---|
| Opus | 15/15 | 9/15 | **+40 pp** |
| Haiku | 11–15/15 across runs | 8/15 | +20 to +47 pp |

Two things worth reading off that table.

The **Haiku spread is the more useful number.** Three consecutive runs of an unchanged map
scored 13, 15, and 11. Nothing changed between them but sampling. If I had run this once
and shipped the 15, the next run would have looked like a 4-point regression and I would
have spent an afternoon debugging a map that was fine. That variance is why the harness
samples repeatedly and collapses by majority, and it is the single most important thing I
learned building it.

The **6 fixtures that tie** are the ones that justify keeping the map honest. Opus routes
them correctly with no help at all. Every line of the map serving only those cases is pure
cost, and the per-fixture output flags them explicitly so they can be cut.

## How it works

```
eval/run.mjs        spawns the agent CLI once per (fixture x arm x sample), scores, reports
eval/score.mjs      the scoring rules as pure functions — majority vote, flakiness, delta
eval/audit.mjs      drift check: skills missing from the map, and map entries pointing at nothing
hooks/inject-map.mjs  the SessionStart hook being measured, with the off-switch that makes it measurable
```

A fixture is one line of JSONL:

```json
{"id":"design-refine","prompt":"...Which of my installed skills handles this?","expect":"design-critique","distractor":"design-build"}
```

`expect` is matched as a case-insensitive regex against the response. `distractor` is
documentation — it records which wrong answer the fixture was built to rule out, which is
the difference between a fixture that tests something and a fixture that passes.

### The off-switch

The hook must exit early when the eval sets its variable. Without this there is no OFF arm
and nothing to compare against:

```js
if (process.env.EVAL_INJECTION_OFF === "1") process.exit(0);
```

## Running it

Requires Node 18+ and the `claude` CLI on `PATH`.

```bash
cp eval/fixtures.example.jsonl eval/fixtures.jsonl   # then write your own
node eval/run.mjs                                     # both arms, 3 samples, default model
node eval/run.mjs --model haiku --repeat 5
node eval/run.mjs --arm on --limit 3                  # quick check; history not written
node eval/audit.mjs                                   # drift check, no model calls
npm test                                              # scoring rules
```

Output:

```
  design-refine          on: HIT 3/3  off:MISS 0/3  <- injection earned this
  design-build           on: HIT 2/3  off:MISS 1/3  <- injection earned this [FLAKY]
  prior-work             on: HIT 3/3  off: HIT 3/3  <- tie (routed fine without it)

Injection ON : 15/15
Injection OFF: 9/15
Delta        : 40 percentage points
```

| Flag | Default | |
|---|---|---|
| `--model` | `opus` | passed straight to `claude --model` |
| `--repeat` | `3` | samples per cell; raise it when fixtures are flaky |
| `--arm` | both | `on` or `off` to run a single arm |
| `--limit` | all | first N fixtures |
| `--concurrency` | `4` | keep it low; oversubscribing turns results into timeouts |
| `--timeout` | `240000` | ms per call; a timeout scores as a miss |
| `--off-env` | `EVAL_INJECTION_OFF` | the variable your hook checks |

## Design decisions worth arguing with

**Majority vote, not any-hit or all-hit.** Any-hit flatters a model that gets there one
time in five. All-hit reports a regression the first time a good fixture blinks. Majority
tracks "would this usually work", which is the question. An even split scores as a miss —
a coin flip is not a pass.

**Partial runs never touch history.** A `--limit 3` run appended to the log reads as a
full run later; a `3/3` row sitting next to a `15/15` row looks like a collapse in
coverage and nothing in the row says otherwise. Partial runs print and exit.

**Flakiness is surfaced, not smoothed.** A fixture that splits its samples is telling you
the *prompt* is ambiguous, not that the map is wrong. Those are the fixtures to rewrite,
so they get a `[FLAKY]` tag rather than being quietly rounded off.

**`audit.mjs` reports and exits 0.** Map drift is a quality signal, not a build failure.
A drift check that blocks work gets bypassed, and a bypassed check is worse than none.

**A hit is a regex match, not a judge.** Model-graded evals are more flexible and add a
second nondeterministic system to the measurement. Since every fixture here asks for one
skill name, a regex is sufficient and fully deterministic. If your fixtures need judgment,
this is the assumption to replace first.

## The audit

Hand-authored maps rot in exactly two directions, and both fail silently:

```
UNINDEXED  a skill exists but the map never mentions it   -> unroutable
DANGLING   the map names a skill you uninstalled          -> routes to nothing
```

`audit.mjs` reports both, plus the map's line count against a budget. The budget matters
more than it looks: this text is prepended to every session, so its cost is paid per
session forever while its benefit is paid once. Mine is capped at 120 lines.

## License

MIT — see [LICENSE](LICENSE).
