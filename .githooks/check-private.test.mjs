import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = dirname(fileURLToPath(import.meta.url));
const HOME_PATH = ["C:", "Users", "alex", "notes.md"].join("/");
const TOKEN = "ghp" + "_" + "a".repeat(36);
const PRIVATE_WORD = "zebra" + "-plans";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "check-private-"));
  const work = join(root, "work");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  const g = (...args) => execFileSync("git", args, { cwd: work, encoding: "utf8" });
  g("config", "user.email", "t@example.invalid");
  g("config", "user.name", "t");
  cpSync(HOOKS, join(work, ".githooks"), { recursive: true });
  writeFileSync(join(work, "README.md"), "hello\n");
  g("add", "-A");
  g("commit", "-q", "--no-verify", "-m", "init");
  g("remote", "add", "origin", remote);
  g("push", "-q", "origin", "main");
  g("config", "core.hooksPath", ".githooks");
  return { work, remote, g };
}

const check = (cwd, args, input) =>
  spawnSync("node", [join(cwd, ".githooks", "check-private.mjs"), ...args], { cwd, input, encoding: "utf8" });

test("a clean staged change passes", () => {
  const { work, g } = repo();
  writeFileSync(join(work, "a.ts"), "export const x = 1;\n");
  g("add", "a.ts");
  assert.equal(check(work, ["staged"]).status, 0);
});

test("a staged home path is blocked and the matched text is not echoed", () => {
  const { work, g } = repo();
  writeFileSync(join(work, "a.md"), `see ${HOME_PATH}\n`);
  g("add", "a.md");
  const r = check(work, ["staged"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /staged a\.md: absolute home path/);
  assert.doesNotMatch(r.stderr, /alex/);
});

test("a staged token is blocked", () => {
  const { work, g } = repo();
  writeFileSync(join(work, "b.ts"), `const t = "${TOKEN}";\n`);
  g("add", "b.ts");
  assert.equal(check(work, ["staged"]).status, 1);
});

test("a made-up test key passes while a real-looking one is blocked", () => {
  const { work, g } = repo();
  writeFileSync(join(work, "k.test.ts"), `const pasted = "${"sk-ant" + "-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"}";\n`);
  g("add", "k.test.ts");
  assert.equal(check(work, ["staged"]).status, 0);
  writeFileSync(join(work, "k.test.ts"), `const pasted = "${"sk-ant" + "-api03-Q7vR2mK9pL4xT8nW3sZ6yB1c"}";\n`);
  g("add", "k.test.ts");
  assert.equal(check(work, ["staged"]).status, 1);
});

test("the clone's own patterns file blocks a word only when the file lists it", () => {
  const { work, g } = repo();
  writeFileSync(join(work, "c.md"), `the ${PRIVATE_WORD} doc\n`);
  g("add", "c.md");
  assert.equal(check(work, ["staged"]).status, 0);
  mkdirSync(join(work, ".git", "info"), { recursive: true });
  writeFileSync(join(work, ".git", "info", "private-patterns"), `# team words\n${PRIVATE_WORD}\n`);
  assert.equal(check(work, ["staged"]).status, 1);
});

test("a private file name is blocked as a new path", () => {
  const { work, g } = repo();
  writeFileSync(join(work, ".git", "info", "private-patterns"), `^${PRIVATE_WORD}\\.md$\n`);
  writeFileSync(join(work, `${PRIVATE_WORD}.md`), "nothing private inside\n");
  g("add", "-A");
  const r = check(work, ["staged"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /new path/);
});

test("the real commit hook refuses a bad commit", () => {
  const { work, g } = repo();
  writeFileSync(join(work, "d.md"), `${HOME_PATH}\n`);
  g("add", "d.md");
  const r = spawnSync("git", ["commit", "-q", "-m", "bad"], { cwd: work, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.equal(g("log", "--format=%s", "-1").trim(), "init");
});

test("the real push hook refuses a commit made with --no-verify, by content or by message", () => {
  const { work, remote, g } = repo();
  g("switch", "-q", "-c", "leaky");
  writeFileSync(join(work, "e.md"), `${HOME_PATH}\n`);
  g("add", "e.md");
  g("commit", "-q", "--no-verify", "-m", "content leak");
  const r = spawnSync("git", ["push", "-q", "origin", "leaky"], { cwd: work, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.equal(execFileSync("git", ["--git-dir", remote, "branch", "--list", "leaky"], { encoding: "utf8" }).trim(), "");

  g("switch", "-q", "main");
  g("switch", "-q", "-c", "leaky-message");
  writeFileSync(join(work, "f.md"), "fine\n");
  g("add", "f.md");
  g("commit", "-q", "--no-verify", "-m", `notes from ${HOME_PATH}`);
  assert.notEqual(spawnSync("git", ["push", "-q", "origin", "leaky-message"], { cwd: work }).status, 0);
});

test("the real push hook lets a clean branch through", () => {
  const { work, remote, g } = repo();
  g("switch", "-q", "-c", "clean");
  writeFileSync(join(work, "g.md"), "fine\n");
  g("add", "g.md");
  g("commit", "-q", "-m", "clean");
  const r = spawnSync("git", ["push", "-q", "origin", "clean"], { cwd: work, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(execFileSync("git", ["--git-dir", remote, "branch", "--list", "clean"], { encoding: "utf8" }), /clean/);
});

test("review findings stay fixed", async (t) => {
  await t.test("a private commit message is refused by the commit-msg hook", () => {
    const { work, g } = repo();
    writeFileSync(join(work, ".git", "info", "private-patterns"), `${PRIVATE_WORD}\n`);
    writeFileSync(join(work, "m.md"), "fine\n");
    g("add", "m.md");
    assert.notEqual(spawnSync("git", ["commit", "-q", "-m", `about ${PRIVATE_WORD}`], { cwd: work }).status, 0);
    assert.equal(g("log", "--format=%s", "-1").trim(), "init");
  });
  await t.test("an added line that starts with ++ is still scanned", () => {
    const { work, g } = repo();
    writeFileSync(join(work, "p.md"), `++ ${HOME_PATH}\n`);
    g("add", "p.md");
    assert.equal(check(work, ["staged"]).status, 1);
  });
  await t.test("a lowercase users folder is a home path", () => {
    assert.equal(check(repo().work, ["stdin"], `${HOME_PATH.replace("Users", "users")}\n`).status, 1);
  });
  await t.test("CRLF text still matches an anchored pattern", () => {
    const { work } = repo();
    writeFileSync(join(work, ".git", "info", "private-patterns"), `^${PRIVATE_WORD}$\n`);
    assert.equal(check(work, ["stdin"], `${PRIVATE_WORD}\r\n`).status, 1);
  });
  await t.test("a real token after a made-up one on the same line is blocked", () => {
    const fake = "sk-ant" + "-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    assert.equal(check(repo().work, ["stdin"], `${fake} ${TOKEN}\n`).status, 1);
  });
  await t.test("the word example does not excuse a token", () => {
    assert.equal(check(repo().work, ["stdin"], `${"sk-ant" + "-api03-example" + "Q7vR2mK9pL4xT8nW3sZ6"}\n`).status, 1);
  });
  await t.test("a non-ASCII private file name is caught", () => {
    const { work, g } = repo();
    writeFileSync(join(work, ".git", "info", "private-patterns"), `^แผน-${PRIVATE_WORD}\\.md$\n`);
    writeFileSync(join(work, `แผน-${PRIVATE_WORD}.md`), "x\n");
    g("add", "-A");
    assert.equal(check(work, ["staged"]).status, 1);
  });
  await t.test("a private branch name is refused on push", () => {
    const { work, g } = repo();
    writeFileSync(join(work, ".git", "info", "private-patterns"), `${PRIVATE_WORD}\n`);
    g("switch", "-q", "-c", `feature/${PRIVATE_WORD}`);
    writeFileSync(join(work, "b.md"), "fine\n");
    g("add", "b.md");
    g("commit", "-q", "-m", "fine");
    assert.notEqual(spawnSync("git", ["push", "-q", "origin", "HEAD"], { cwd: work }).status, 0);
  });
  await t.test("a push whose old remote tip is unknown locally still scans", () => {
    const { work, g } = repo();
    writeFileSync(join(work, "u.md"), `${HOME_PATH}\n`);
    g("add", "u.md");
    g("commit", "-q", "--no-verify", "-m", "u");
    const line = `refs/heads/main ${g("rev-parse", "HEAD").trim()} refs/heads/main ${"1".repeat(40)}\n`;
    assert.equal(check(work, ["push", "origin"], line).status, 1);
  });
  await t.test("the install script turns the hooks on", () => {
    const { work, g } = repo();
    g("config", "--unset", "core.hooksPath");
    spawnSync("node", [join(work, ".githooks", "install.mjs")], { cwd: work });
    assert.equal(g("config", "core.hooksPath").trim(), ".githooks");
  });
});

test("tree mode scans tracked files, and stdin mode scans piped text", () => {
  const { work, g } = repo();
  assert.equal(check(work, ["tree"]).status, 0);
  writeFileSync(join(work, "h.md"), `${TOKEN}\n`);
  g("add", "h.md");
  g("commit", "-q", "--no-verify", "-m", "h");
  assert.equal(check(work, ["tree"]).status, 1);
  assert.equal(check(work, ["stdin"], `${HOME_PATH}\n`).status, 1);
  assert.equal(check(work, ["stdin"], "nothing here\n").status, 0);
});


test("binary payloads are scanned when staged, committed in the tree, and pushed", () => {
  const { work, remote, g } = repo();
  const payload = Buffer.concat([Buffer.from([0, 1, 255]), Buffer.from(` ${TOKEN} `), Buffer.from([0, 2])]);
  writeFileSync(join(work, "payload.bin"), payload);
  g("add", "payload.bin");
  assert.equal(check(work, ["staged"]).status, 1);
  g("commit", "-q", "--no-verify", "-m", "binary");
  assert.equal(check(work, ["tree"]).status, 1);
  assert.notEqual(spawnSync("git", ["push", "-q", "origin", "main"], { cwd: work, encoding: "utf8" }).status, 0);
  assert.equal(execFileSync("git", ["--git-dir", remote, "log", "--format=%s", "-1", "main"], { encoding: "utf8" }).trim(), "init");
});
