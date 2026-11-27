// usage: node check-private.mjs staged | message <file> | push <remote> | tree | stdin
// Exit 1 when added text matches a built-in rule or a line of the clone's untracked
// patterns file, so private names never enter this public repo's history.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BUILT_IN = [
  ["absolute home path", /\b[A-Za-z]:[\\/]+[Uu][Ss][Ee][Rr][Ss][\\/]+[^\\/\s"'`]+|\/c\/[Uu]sers\/[^/\s"'`]+|\/home\/[a-z_][\w.-]*\/|\/Users\/[A-Za-z][\w.-]*\//g],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["API token", /\b(?:sk-ant-[\w-]{20,}|sk-proj-[\w-]{20,}|sk-or-v1-[\w-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_\w{30,}|lin_api_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|xox[bpa]-[\w-]{10,}|sk_live_\w{20,}|rk_live_\w{20,})/g],
];

// Tests here carry made-up keys such as sk-ant-api03-AbCdEf... to exercise redaction.
const PLACEHOLDER = /abcdefgh|AbCdEfGh|Ab12Cd34|0123456789abcdef|fake|not-a-(?:real-)?key|x{8,}/i;

const git = (args, opts = {}) =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 1 << 28, ...opts });

function patternsFile() {
  if (process.env.PRIVATE_PATTERNS_FILE) return process.env.PRIVATE_PATTERNS_FILE;
  return join(resolve(git(["rev-parse", "--git-common-dir"]).trim()), "info", "private-patterns");
}

function rules() {
  const file = patternsFile();
  if (!existsSync(file)) {
    console.error(`check-private: no ${file}, so only the built-in rules ran. See AGENTS.md.`);
    return BUILT_IN;
  }
  const local = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l, i) => [`private pattern on line ${i + 1} of ${file}`, new RegExp(l, "gi")]);
  return [...BUILT_IN, ...local];
}

function addedLines(patch, where) {
  const out = [];
  let file = where;
  let inHunk = false;
  let afterMinus = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (!inHunk && afterMinus && line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
    else if (!inHunk && /^(rename|copy) to /.test(line)) out.push({ where: `${where}path`, text: line.replace(/^(rename|copy) to /, "") });
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("+")) out.push({ where: `${where}${file}`, text: line.slice(1) });
    afterMinus = !inHunk && line.startsWith("--- ");
  }
  return out;
}

function commitsToPush(localSha, remoteSha, remote) {
  const unpublished = [localSha, "--not", `--remotes=${remote}`];
  if (/^0+$/.test(remoteSha)) return git(["rev-list", ...unpublished]);
  try {
    return git(["rev-list", `${remoteSha}..${localSha}`], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return git(["rev-list", ...unpublished]);
  }
}

function pushed(stdin, remote) {
  const lines = [];
  const commits = new Set();
  for (const line of stdin.split(/\r?\n/).filter(Boolean)) {
    const [, localSha, remoteRef, remoteSha] = line.split(" ");
    if (/^0+$/.test(localSha)) continue;
    lines.push({ where: "pushed ref name", text: remoteRef });
    for (const c of commitsToPush(localSha, remoteSha, remote).split("\n").filter(Boolean)) commits.add(c);
  }
  for (const c of commits) {
    const short = c.slice(0, 7);
    lines.push(...git(["log", "-1", "--format=%B", c]).split("\n").map((text) => ({ where: `${short} message`, text })));
    lines.push(...git(["show", "--format=", "--name-only", "--diff-filter=ACR", c]).split("\n").filter(Boolean).map((text) => ({ where: `${short} new path`, text })));
    lines.push(...addedLines(git(["show", "--format=", "--text", "-U0", "--no-color", "--no-ext-diff", "-C", c]), `${short} `));
  }
  return lines;
}

function collect(mode, arg) {
  if (mode === "staged") {
    const names = git(["diff", "--cached", "--name-only", "--diff-filter=ACR"]).split("\n").filter(Boolean);
    return [
      ...names.map((text) => ({ where: "new path", text })),
      ...addedLines(git(["diff", "--cached", "--text", "-U0", "--no-color", "--no-ext-diff", "-C"]), "staged "),
    ];
  }
  if (mode === "message") return readFileSync(arg, "utf8").split("\n").filter((l) => !l.startsWith("#")).map((text) => ({ where: "commit message", text }));
  if (mode === "push") return pushed(readFileSync(0, "utf8"), arg ?? "origin");
  if (mode === "tree") {
    const names = git(["ls-files"]).split("\n").filter(Boolean).map((text) => ({ where: "tracked path", text }));
    const content = git(["grep", "--text", "-n", "-e", ""], { stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const m = /^(.*?):(\d+):(.*)$/.exec(l);
        return m ? { where: `${m[1]}:${m[2]}`, text: m[3] } : { where: "tree", text: l };
      });
    return [...names, ...content];
  }
  if (mode === "stdin") return readFileSync(0, "utf8").split("\n").map((text, i) => ({ where: `stdin:${i + 1}`, text }));
  throw new Error("usage: check-private.mjs staged | message <file> | push <remote> | tree | stdin");
}

const all = rules();
const hits = [];
for (const { where, text: raw } of collect(process.argv[2], process.argv[3])) {
  const text = raw.replace(/\r$/, "");
  for (const [name, re] of all) {
    const real = [...text.matchAll(re)].filter((m) => !(name === "API token" && PLACEHOLDER.test(m[0])));
    if (real.length) hits.push(`${where}: ${name}`);
  }
}
if (hits.length) {
  console.error(`check-private: blocked, ${hits.length} match(es). Remove the text, or rewrite the commit before pushing.`);
  for (const h of hits.slice(0, 50)) console.error(`  ${h}`);
  process.exit(1);
}
