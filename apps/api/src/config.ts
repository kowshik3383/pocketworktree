import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type Check = { name: string; command: string; args: string[] };
export type Repo = { id: string; name: string; path: string; baseRef: string; checks: Check[] };

export function loadConfig() {
  const password = process.env.POCKETWORKTREE_PASSWORD ?? "";
  if (password.length < 16) throw new Error("Set POCKETWORKTREE_PASSWORD to at least 16 characters.");
  const origin = new URL(process.env.POCKETWORKTREE_ORIGIN ?? "http://127.0.0.1:3000");
  if (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) {
    throw new Error("Use HTTPS for a remote dashboard origin.");
  }
  const filename = process.env.POCKETWORKTREE_CONFIG;
  if (!filename || !isAbsolute(filename)) throw new Error("Set POCKETWORKTREE_CONFIG to an absolute JSON file path.");
  const { model, repos } = JSON.parse(readFileSync(filename, "utf8")) as { model: string; repos: Repo[] };
  if (typeof model !== "string" || !model.startsWith("ollama/") || model.length <= 7) {
    throw new Error("Configure an ollama/<installed-model> model.");
  }
  if (!Array.isArray(repos) || !repos.length ||
      repos.some((repo) => !repo || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(repo.id) ||
        typeof repo.name !== "string" || typeof repo.path !== "string" || !isAbsolute(repo.path) ||
        typeof repo.baseRef !== "string" || !repo.baseRef.startsWith("refs/heads/") ||
        !Array.isArray(repo.checks) || repo.checks.some((check) => !check ||
          typeof check.name !== "string" || typeof check.command !== "string" || !check.command ||
          !Array.isArray(check.args) || check.args.some((arg) => typeof arg !== "string"))) ||
      new Set(repos.map((repo) => repo.id)).size !== repos.length) {
    throw new Error("Configure uniquely named repos with absolute paths, refs/heads/ base refs, and check commands.");
  }
  return {
    password,
    origin: origin.origin,
    secure: origin.protocol === "https:",
    model,
    repos,
    dataDir: resolve(process.env.POCKETWORKTREE_DATA_DIR ?? ".pocketworktree"),
  };
}
