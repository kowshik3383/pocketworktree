# PocketWorktree

PocketWorktree is a self-hosted dashboard for submitting coding tasks from your phone and reviewing the Git patches produced on your own machine.

## Current milestone

The Next.js website submits task prompts to a NestJS API. SQLite stores the queue and keeps recent jobs across restarts. Jobs stay queued until the OpenCode worker is implemented.

Both services bind to loopback. Keep this milestone on your own machine. Add owner authentication and private network access before exposing the dashboard to another device.

## Run locally

Install Node.js 24 or later, then run `npm install` from the repository root. Start both processes in separate terminals from the root:

| Process | Command | Address |
| --- | --- | --- |
| NestJS API | `npm run api` | http://127.0.0.1:4000/api/health |
| Next.js site | `npm run web` | http://127.0.0.1:3000 |

Open the dashboard, submit a task, then reload. The job should stay in the queue. The API writes the SQLite database under `.pocketworktree/` in its working directory by default. Set `POCKETWORKTREE_DATA_DIR` to an absolute path to choose a different directory.

Run `npm run typecheck` and `npm run build` from the root.

## Roadmap

1. Register a local repo and resolve its configured base branch to an exact Git commit.
2. Claim one queued job at a time and create a detached worktree for it.
3. Start and monitor an OpenCode session backed by a local Ollama model.
4. Run configured checks and capture a reviewable patch, including new files.
5. Add job cancellation, owner authentication, and private phone access.

See [the implementation plan](docs/implementation-plan.md).
