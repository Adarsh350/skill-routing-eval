#!/usr/bin/env node
// audit.mjs — drift check for a hand-authored routing map.
//
// The map is hand-authored because routing judgment cannot be generated: knowing that
// two skills collide, and which one wins, is a decision. Hand-authored means it rots,
// in exactly two directions:
//
//   UNINDEXED  a skill exists but the map never mentions it -> effectively unroutable
//   DANGLING   the map names a skill that is no longer installed -> routes to nothing
//
// Both are silent failures. Nothing errors; the agent just picks worse and you never
// find out. This finds them in a second.
//
// Run: node eval/audit.mjs
// Exits 0 always. It reports; it does not gate.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const argVal = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : d;
};

const HOME = os.homedir();
const digestPath = argVal("--map", path.join(HOME, ".claude", "skills", "route", "DIGEST.md"));
const skillsDir = argVal("--skills", path.join(HOME, ".claude", "skills"));
const selfRoutingPath = argVal("--self-routing", path.join("eval", "self-routing.txt"));

// The soft budget for the map. This text is prepended to every single session, so its cost
// is paid per session forever while its benefit is paid once. A map that grows without a
// ceiling stops being a routing aid and becomes a tax.
const MAX_LINES = Number(argVal("--max-lines", 120));

// Skills whose NAME alone says when to use them are deliberately absent from the map, not
// missing from it — indexing `pricing-strategy` teaches the agent nothing. Listing a name
// here is a claim that the name is self-explanatory; keep the list honest or the audit
// stops catching real gaps. One name or glob per line, `#` for comments.
function selfRoutingMatcher() {
  let patterns = [];
  try {
    patterns = fs
      .readFileSync(selfRoutingPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return () => false;
  }
  const res = patterns.map(
    (p) => new RegExp("^" + p.split("*").map(escapeRe).join(".*") + "$", "i")
  );
  return (name) => res.some((re) => re.test(name));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function installedSkills() {
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, "SKILL.md")))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

let mapText;
try {
  mapText = fs.readFileSync(digestPath, "utf8");
} catch {
  console.error(`No routing map at ${digestPath}`);
  process.exit(0);
}

const isSelfRouting = selfRoutingMatcher();
const installed = installedSkills();

const unindexed = installed.filter((n) => !mapText.includes(n) && !isSelfRouting(n));

// Every backticked identifier in the map should resolve to something installed. Names
// containing ":" are plugin-scoped and names containing "." are filenames — neither is a
// local skill directory, so both are excluded rather than reported as false positives.
const cited = [
  ...new Set([...mapText.matchAll(/`([a-z0-9][a-z0-9:-]{2,})`/g)].map((m) => m[1])),
];
const dangling = cited.filter(
  (n) => !installed.includes(n) && !n.includes(":") && !n.includes(".")
);

console.log(`Installed skills:          ${installed.length}`);
console.log(`Named in the routing map:  ${cited.length}`);

if (unindexed.length) {
  console.log(`\nUNINDEXED (${unindexed.length}) — installed but not in the map, so unroutable:`);
  for (const n of unindexed) console.log(`  - ${n}`);
} else {
  console.log("\nUNINDEXED: none.");
}

if (dangling.length) {
  console.log(`\nDANGLING (${dangling.length}) — in the map but not installed:`);
  for (const n of dangling) console.log(`  - ${n}`);
} else {
  console.log("DANGLING: none.");
}

const lines = mapText.split("\n").length;
const over = lines > MAX_LINES ? `  OVER BUDGET by ${lines - MAX_LINES}` : "";
console.log(`\nMap size: ${lines} lines (budget ${MAX_LINES}; every session pays this).${over}`);
