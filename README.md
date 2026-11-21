# PocketWorktree

Run OpenCode on your own machine from your phone. Queue coding tasks, follow their progress, and review Git patches from a private, self-hosted dashboard.

## Start on your machine

You need Node.js 24, Git, OpenCode, Ollama, and a Git repository with a local branch. Use Linux, macOS, or WSL. Test with a disposable repository first.

1. Run `npm install` from this repository's root.
2. OpenCode must be able to run your local, tool-capable model. Run `opencode models` and find the model under the `ollama/` provider. Try `opencode run --model ollama/YOUR_MODEL "Say hello"` before starting the dashboard.
3. Copy `config.example.json` to `config.local.json`. Set the model, an absolute repo path, and the full local base ref. A check is an object such as `{"name":"Typecheck","command":"npm","args":["run","typecheck"]}`. Commands run in the job checkout, so include any necessary setup as an earlier check or use a disposable repo without dependencies.
4. In the API terminal, set an owner password and the config path. Keep the password out of the repository.

   ```bash
   export POCKETWORKTREE_CONFIG="$PWD/config.local.json"
   export POCKETWORKTREE_DATA_DIR="$PWD/.pocketworktree"
   read -rs -p 'Owner password (at least 16 characters): ' POCKETWORKTREE_PASSWORD; echo
   export POCKETWORKTREE_PASSWORD
   npm run api
   ```

5. In a separate terminal, run `npm run web`. Open [the local dashboard](http://127.0.0.1:3000), sign in, and submit a task. Match the configured origin exactly.

The worker runs one job at a time. It edits a detached worktree, runs configured checks, and captures the full patch against the recorded base commit, including new files. A finished job can include failed checks, which appear separately. The dashboard supports cancelling, downloading the patch, and reusing a task prompt. Commit and push manually after reviewing the patch.

## Open it from your phone

Build with `npm run build`, then use `npm run start --workspace @pocketworktree/api` and `npm run start --workspace @pocketworktree/web` instead of the development servers. Keep both Node processes bound to loopback. Use an HTTPS reverse proxy restricted to your private network to forward requests to `127.0.0.1:3000`. Set `POCKETWORKTREE_ORIGIN` in the API terminal to the exact HTTPS dashboard URL, without a path, and restart the API. Visit that URL on your phone. The machine must stay awake while jobs run.

For example, if you already use Tailscale, configure [Tailscale Serve](https://tailscale.com/kb/1312/serve) to proxy the local Next.js port within your tailnet. Use the HTTPS URL it reports as `POCKETWORKTREE_ORIGIN`.

## Host setup and recovery

- Run the API and OpenCode from a dedicated OS account or an isolated host with access to only the registered projects. Use trusted local repos. A Git worktree provides a separate checkout, and OS permissions control what the agent can read and execute. Keep credentials and production secrets out of that account.
- The worker runs `opencode run` in the checkout with the configured Ollama model and captures JSON output for activity. Pin and test your installed CLI build before relying on it for unattended runs. No separate OpenCode web server is required.
- Job records, logs, patches, and worktrees are stored under `POCKETWORKTREE_DATA_DIR`. Review and remove old worktrees manually with `git worktree list` and `git worktree remove` from the registered repository. Preserve any changes you need before removing a checkout.
- If the API restarts with a job in progress, the queue pauses. Verify the old OpenCode process and its child commands have stopped. Restart once with `POCKETWORKTREE_RESUME_INTERRUPTED=1` to mark the interrupted job failed and resume queued jobs. Remove the flag for normal starts.
- Owner sessions expire after 12 hours or when the API restarts. Prompt and log data are stored on the host.

## Verify

Run `npm run typecheck`, `npm run build`, then `node scripts/smoke.mjs`. The smoke test runs the compiled API with a disposable Git repo and a fake OpenCode command. It checks authentication, idempotency, worktree isolation, and patch capture. Run a real job with Ollama separately to qualify your model and host.

See [implementation notes](docs/implementation-plan.md).
