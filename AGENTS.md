# Giraffe: rules for coding agents

Giraffe is a personal AI assistant people text. `app/` is a Cloudflare Worker with one SQLite-backed Durable Object per person. `box/` is the per-person machine that runs Claude Code for people who bring their own Claude plan. `README.md` says what works today and how each piece was checked.

This file is the shared floor for every coding agent: Claude Code, Codex, OpenCode, Cursor, Antigravity and Gemini CLI all read it. Change it by PR. Your own preferences go in your own files (see "Your own setup").

## First time in a clone

- Node 24. Run `npm ci` in `app/` and in `box/`. The one in `app/` also turns on the private-text check (`git config core.hooksPath .githooks`).
- Put your private words in `.git/info/private-patterns` (see "Private text never enters git"). Without that file, only the built-in rules run.

## Commands

- `app/`: `npm test` (vitest in the Workers runtime, no network), `npm run typecheck`, `npm run dev` (wrangler on port 8787), `npm run bridge` (a real model through your own `claude` login). `app/README.md` has the local and deploy steps.
- `box/`: `npm test` (Node's test runner). `npx vitest` there finds no tests and exits 0, which proves nothing.
- `.githooks/`: `node --test .githooks/check-private.test.mjs`.

## Proving a change

- A change to replies, reminders, check-ins, follow and block, delivery, billing or the ledger is proven in the running app, not only in tests. The recipe is `.claude/skills/giraffes-verify/SKILL.md`. Claude Code loads it as a skill; other agents read the file. It drives the dev channel with a scripted backend or a real model and saves evidence.
- Report what ran and on which commit. A scripted or mocked run is not proof of model behaviour, so label it.
- Tests assert what a person or a caller can observe, not internals.

## Code

- The model only proposes actions. Code enforces every limit: reminder caps, unasked-message caps, quiet hours, message length. Keep it that way.
- Keep business logic in pure functions. Validate at the boundaries: webhooks, the model's turn output, provider responses.
- Make the smallest change that solves the problem. Write a comment only for a reason the code can't show.

## Private text never enters git

This repo is public, and git history is permanent. Never put these in a tracked file or a commit message: absolute home paths, names of private files or folders, tracker issue keys, internal planning or process notes, people's contact details, keys or tokens.

Plans, research notes and agent scratch files stay outside the repo folder, not just git-ignored inside it. Track work in the issue tracker. A merged PR is the record of what changed.

`.githooks/check-private.mjs` checks every commit, commit message and push. It blocks a home path, a private-key block or a common token shape. It also blocks every regex listed in your clone's untracked `.git/info/private-patterns` file, one per line. Never bypass it with `--no-verify`. If it blocks a push, rewrite that local commit first.

## Git

- One branch and one worktree per task. Changes reach `main` by PR.
- Never run `git stash`. Worktrees share one stash, so a parallel agent can pop yours. Set work aside with a WIP commit. The Claude Code hook in `.claude/settings.json` blocks it.
- Stage files by path. No force-push, no rewriting pushed commits, no `--no-verify`.

## Needs a person

Deploys, anything that spends money or creates cloud resources (Cloudflare, Fly, Stripe), messages to real users or testers, signing in to any account, and any new third party that receives user data.

## Your own setup

Personal instructions live outside the repo, so they apply in every worktree and never get committed:

- Claude Code: `~/.claude/CLAUDE.md`. `CLAUDE.local.md` in the repo root also works and git ignores it, but new worktrees don't get a copy. Personal settings go in `.claude/settings.local.json`.
- Codex: `~/.codex/AGENTS.md`. Don't create `AGENTS.override.md` in the repo: Codex then skips this file.
- OpenCode: `~/.config/opencode/AGENTS.md`.
- Antigravity: `~/.gemini/AGENTS.md`. Gemini CLI reads `GEMINI.md` unless `context.fileName` in `~/.gemini/settings.json` lists `AGENTS.md`.
- Cursor: User Rules in its settings.
