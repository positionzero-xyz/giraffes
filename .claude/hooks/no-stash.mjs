// Worktrees share one stash, so a parallel writer's `git stash pop` can apply a sibling's stash.
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const command = JSON.parse(raw || "{}").tool_input?.command ?? "";
  const changesStash = /\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*\s+stash\b(?!\s+(?:list|show)\b)/.test(command);
  if (!changesStash) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "git stash is shared by every worktree of this repo, so another writer can pop yours. Set work aside with a WIP commit (git revert --no-commit for a deliberate break) or git show <rev>:<path> to a temp file. git stash list and git stash show are allowed.",
      },
    }),
  );
});
