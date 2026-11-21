import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "pocketworktree-"));
const repo = join(root, "repo");
const bin = join(root, "bin");
const config = join(root, "config.json");
const origin = "http://127.0.0.1:3000";
const baseURL = "http://127.0.0.1:4000/api";
const password = randomUUID();
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
let host;
let output = "";

async function until(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(200);
  }
  assert.fail(`Timed out. API output:\n${output}`);
}

try {
  mkdirSync(repo);
  mkdirSync(bin);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Smoke Test");
  git("config", "user.email", "smoke@example.invalid");
  writeFileSync(join(repo, "original.txt"), "before\n");
  writeFileSync(join(repo, "remove.txt"), "remove this\n");
  git("add", ".");
  git("commit", "-qm", "Fixture");

  writeFileSync(join(bin, "opencode"), [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "fs.writeFileSync('original.txt', 'after\\n');",
    "fs.writeFileSync('new.txt', 'new file\\n');",
    "fs.unlinkSync('remove.txt');",
    "console.log(JSON.stringify({ type: 'text', text: 'Edited fixture' }));",
    "",
  ].join("\n"), { mode: 0o700 });

  writeFileSync(config, JSON.stringify({
    model: "ollama/smoke",
    repos: [{ id: "demo", name: "Demo", path: repo, baseRef: "refs/heads/main",
      checks: [{ name: "Check", command: process.execPath, args: ["-e", "process.exit(3)"] }] }],
  }));
  host = spawn(process.execPath, ["apps/api/dist/main.js"], {
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`,
      POCKETWORKTREE_CONFIG: config, POCKETWORKTREE_DATA_DIR: join(root, "data"),
      POCKETWORKTREE_ORIGIN: origin, POCKETWORKTREE_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [host.stdout, host.stderr]) stream.on("data", (chunk) => { output += chunk; });

  await until(async () => {
    assert.equal(host.exitCode, null, output);
    return fetch(baseURL + "/health").then((res) => res.ok).catch(() => false);
  });
  assert.equal((await fetch(baseURL + "/jobs")).status, 401);

  const post = (path, body, cookie, source = origin) => fetch(baseURL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: source, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

  assert.equal((await post("/auth/login", { password }, undefined, "https://example.invalid")).status, 403);
  const login = await post("/auth/login", { password });
  assert.equal(login.status, 204, output);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const payload = { repoId: "demo", prompt: "Edit fixture", requestId: randomUUID() };
  const submission = await post("/jobs", payload, cookie);
  assert.equal(submission.status, 202);
  const job = await submission.json();
  assert.equal((await (await post("/jobs", payload, cookie)).json()).id, job.id);

  const get = (path) => fetch(baseURL + path, { headers: { Cookie: cookie } });
  const completed = await until(async () => {
    const current = await (await get(`/jobs/${job.id}`)).json();
    return ["completed", "failed"].includes(current.status) ? current : undefined;
  });
  assert.equal(completed.status, "completed", completed.error ?? output);
  assert.equal(completed.baseCommit, git("rev-parse", "HEAD").trim());
  assert.equal(completed.checks[0].code, 3);
  assert.deepEqual(completed.files, ["new.txt", "original.txt", "remove.txt"]);
  const diff = await get(`/jobs/${job.id}/diff`);
  assert.equal(diff.status, 200);
  const patch = await diff.text();
  assert.match(patch, /\+new file/);
  assert.match(patch, /\+after/);
  assert.match(patch, /-remove this/);
  assert.equal(readFileSync(join(repo, "original.txt"), "utf8"), "before\n");
  assert.equal(git("status", "--porcelain"), "");
  const logs = await (await get(`/jobs/${job.id}/logs`)).json();
  assert.ok(logs.some(({ text }) => text.includes("Edited fixture")));
  console.log("PocketWorktree API smoke test passed.");
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    const closed = once(host, "close");
    host.kill("SIGTERM");
    await closed;
  }
  rmSync(root, { recursive: true, force: true });
}
