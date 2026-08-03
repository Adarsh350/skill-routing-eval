#!/usr/bin/env node
// inject-map.mjs — SessionStart hook. Prepends a routing map to every session.
//
// This is the thing the eval measures. It is deliberately trivial: read a file, print it,
// and get out of the way. Two properties matter more than anything it does.
//
//   1. The OFF switch. Without it every session gets the map, there is no baseline, and
//      the map's effect is permanently unmeasurable. An intervention you cannot turn off
//      is an intervention you cannot evaluate.
//
//   2. Silence on failure. A SessionStart hook that throws takes the session with it.
//      A missing map is worth zero; a broken session is worth less than zero.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Control arm for eval/run.mjs.
if (process.env.EVAL_INJECTION_OFF === "1") process.exit(0);

const MAP = process.env.ROUTING_MAP_PATH
  ?? path.join(os.homedir(), ".claude", "skills", "route", "DIGEST.md");

try {
  const text = fs.readFileSync(MAP, "utf8").trim();
  if (!text) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: text,
      },
    })
  );
} catch {
  // No map, unreadable map, bad permissions — start the session anyway.
  process.exit(0);
}
