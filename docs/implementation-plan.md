# PocketWorktree implementation plan

## First milestone

Use a Next.js dashboard, a NestJS API, and SQLite to accept a prompt, persist it, and list recent jobs. Run both services on loopback while the dashboard is unauthenticated.

## Next milestone

- Register repos in host-side configuration with an ID, local path, base ref, and check commands. Return repo IDs and names to the dashboard.
- Add a worker entry point to the NestJS app. Claim jobs atomically, record the resolved Git commit, and create a fresh worktree for every attempt.
- Pin and verify the deployed OpenCode version. Create a session for the job checkout, persist its session ID, submit the prompt, and reconcile session state when an event connection drops. Configure a local Ollama model.
- Run the worker with restricted filesystem permissions and without push credentials. Keep the default checkout untouched. Bound command runtime, logs, and patch size.
- Run configured checks and save their outcomes separately from agent execution. Capture the Git patch against the base commit with a temporary index so added files appear in the review.
- Display progress, check results, changed files, and the patch in the dashboard. When cancelling, confirm the agent has stopped before capturing a partial patch.
- Add owner authentication and private, encrypted phone access. Keep the agent API on loopback.

## Acceptance

Submit a task against a disposable repository that edits one file and adds another. Verify the original checkout stays clean, both changes appear in the patch, and the dashboard shows the check result. Reload during a job and confirm the queued or running state loads from SQLite. Test cancellation and worker restart before using the dashboard with a real project.

## Reference

- [OpenCode API](https://opencode.ai/docs/api)
- [OpenCode web server](https://opencode.ai/docs/cli/web/)
