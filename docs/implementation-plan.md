# PocketWorktree MVP implementation

## Request flow

1. Next.js rewrites same-origin API requests to the loopback NestJS server. The owner signs in with an HTTP-only cookie.
2. NestJS validates the task, matches it to a configured repo, and stores it in SQLite. The request ID deduplicates retries.
3. An in-process background worker claims one queued job at a time, resolves the local base branch, and builds a detached worktree.
4. OpenCode runs as a fresh CLI process in that checkout. The worker polls for queued work, records bounded process output, enforces command deadlines, and stops the process group on cancellation.
5. The worker runs configured commands and captures a binary-capable Git patch against the starting commit using a temporary index. The website polls for job state and incremental logs.
6. A crash leaves running jobs interrupted. The owner verifies the old processes stopped before explicitly restarting the queue.

## Scope after MVP

- Add an API adapter if you need session follow-ups or already run a managed OpenCode server.
- Add automatic worktree retention after deciding how to preserve unreviewed edits.
- Add explicit review approval, then optional GitHub push and PR creation scoped to the reviewed commit.
- Add end-to-end browser coverage and a real Ollama compatibility test for a pinned CLI and model.

## Reference

- [OpenCode CLI](https://opencode.ai/docs/cli/commands)
- [OpenCode local models](https://opencode.ai/docs/models/)
