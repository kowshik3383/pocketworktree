import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { loadConfig } from "./config";
import { runCommand } from "./process";
import { claimJob, type Job } from "./store";

type Config = ReturnType<typeof loadConfig>;
type CheckResult = { name: string; code: number | null; error?: string };

export class Worker {
  private active?: { id: string; controller: AbortController };
  private interval?: NodeJS.Timeout;
  private current?: Promise<void>;

  constructor(private readonly db: DatabaseSync, private readonly config: Config) {}

  start() {
    this.db.exec(`
      UPDATE jobs SET status = 'interrupted', phase = NULL,
        error = 'The host stopped during this job. Check the old processes before resuming the queue.'
      WHERE status = 'running'
    `);
    if (process.env.POCKETWORKTREE_RESUME_INTERRUPTED === "1") {
      this.db.exec("UPDATE jobs SET status = 'failed' WHERE status = 'interrupted'");
    }
    this.interval = setInterval(() => this.tick(), 750);
  }

  async stop() {
    clearInterval(this.interval);
    this.active?.controller.abort();
    await this.current;
  }

  cancel(id: string) {
    if (this.active?.id === id) this.active.controller.abort();
  }

  private tick() {
    if (this.current) return;
    try {
      const job = claimJob(this.db);
      if (!job) return;
      const controller = new AbortController();
      this.active = { id: job.id, controller };
      this.current = this.run(job, controller.signal).catch((error: unknown) => {
        console.error("Worker could not finalize job", job.id, error);
      }).finally(() => {
        this.active = undefined;
        this.current = undefined;
      });
    } catch (error) {
      console.error("Could not claim queued job", error);
    }
  }

  private async run(job: Job, signal: AbortSignal) {
    const repo = this.config.repos.find(({ id }) => id === job.repoId);
    const jobDir = join(this.config.dataDir, "jobs", job.id);
    const worktree = join(jobDir, "checkout");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TMPDIR|XDG_(CONFIG|CACHE|DATA|STATE)_HOME|OLLAMA_HOST|PNPM_HOME)$/.test(key),
    ));
    const localEnv = {
      ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
    };
    const checks: CheckResult[] = [];
    let remainingLogChars = 120_000;
    let baseCommit: string | undefined;
    let created = false;
    let hasPatch = false;
    let files: string[] = [];
    let failure: string | null = null;
    const phase = (value: string) => this.db.prepare("UPDATE jobs SET phase = ? WHERE id = ?").run(value, job.id);
    const log = (text: string) => {
      const bounded = text.slice(0, remainingLogChars);
      if (!bounded) return;
      remainingLogChars -= bounded.length;
      this.db.prepare("INSERT INTO logs (jobId, text) VALUES (?, ?)").run(job.id, bounded);
    };

    async function git(cwd: string, args: string[], maxOutput = 256_000, extraEnv: NodeJS.ProcessEnv = {}) {
      const result = await runCommand("git", args, {
        cwd, env: { ...localEnv, ...extraEnv }, timeout: 30_000, maxOutput, onOutput: undefined,
      });
      if (result.code !== 0) throw new Error(`Git operation failed: ${args[0]}`);
      return result.stdout;
    }

    try {
      if (!repo) throw new Error("This repository is no longer registered.");
      mkdirSync(jobDir, { recursive: true, mode: 0o700 });
      baseCommit = (await git(repo.path, ["rev-parse", "--verify", "--end-of-options", repo.baseRef + "^{commit}"])).toString().trim();
      this.db.prepare("UPDATE jobs SET baseCommit = ? WHERE id = ?").run(baseCommit, job.id);
      if (!signal.aborted) {
        await git(repo.path, ["worktree", "add", "--detach", "--", worktree, baseCommit]);
        created = true;
      }
      if (!signal.aborted) {
        phase("editing");
        log("Starting OpenCode in the job checkout.\n");
        let tail = "";
        let agentError = false;
        const agentOutput = (text: string) => {
          log(text);
          const lines = (tail + text).split("\n");
          tail = (lines.pop() ?? "").slice(-256_000);
          for (const line of lines) {
            try {
              if (JSON.parse(line)?.type === "error") agentError = true;
            } catch {
              // The CLI can also emit plain-text diagnostics.
            }
          }
        };
        const result = await runCommand("opencode", [
          "run", "--model", this.config.model, "--format", "json", "--", job.prompt,
        ], { cwd: worktree, env: localEnv, signal, timeout: 25 * 60_000, onOutput: agentOutput });
        agentOutput("\n");
        if (!result.stopped && (result.code !== 0 || agentError)) throw new Error("OpenCode exited with an error. See the job log.");
      }

      for (const check of repo.checks) {
        if (signal.aborted) break;
        phase("checking");
        log(`\nRunning ${check.name}.\n`);
        try {
          const result = await runCommand(check.command, check.args, {
            cwd: worktree, env: localEnv, signal, timeout: 5 * 60_000, onOutput: log,
          });
          checks.push({ name: check.name, code: result.code, ...(result.stopped ? { error: "Cancelled" } : {}) });
        } catch (error) {
          checks.push({ name: check.name, code: null, error: String(error) });
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    if (created && baseCommit) {
      phase("capturing");
      const index = join(jobDir, "review.index");
      const gitEnv = { GIT_INDEX_FILE: index };
      try {
        await git(worktree, ["read-tree", baseCommit], undefined, gitEnv);
        await git(worktree, ["add", "--all", "--", "."], undefined, gitEnv);
        const diffArgs = ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv"];
        files = (await git(worktree, [...diffArgs, "--name-only", "-z", baseCommit, "--"], undefined, gitEnv))
          .toString("utf8").split("\0").filter(Boolean);
        const patch = await git(worktree, [...diffArgs, "--binary", "--full-index", baseCommit, "--"], 8 * 1024 * 1024, gitEnv);
        writeFileSync(join(jobDir, "review.patch"), patch, { mode: 0o600 });
        hasPatch = true;
      } catch (error) {
        failure ??= error instanceof Error ? error.message : String(error);
      } finally {
        rmSync(index, { force: true });
      }
    }

    const status = signal.aborted ? "cancelled" : failure ? "failed" : "completed";
    this.db.prepare(`
      UPDATE jobs SET status = ?, phase = NULL, error = ?, checks = ?, files = ?, hasPatch = ?
      WHERE id = ?
    `).run(status, failure, JSON.stringify(checks), JSON.stringify(files), Number(hasPatch), job.id);
    log(created ? "\nCheckout retained on the host.\n" : "\nNo checkout was created.\n");
  }
}
