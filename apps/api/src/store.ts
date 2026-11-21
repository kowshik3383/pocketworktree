import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Job = {
  id: string; prompt: string; repoId: string; status: string; createdAt: string;
  phase: string | null; baseCommit: string | null; error: string | null;
  checks: string; files: string; hasPatch: number; cancelRequested: number;
};

export function openStore(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, "jobs.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL
    ) STRICT;
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((row) => row.name));
  const additions = {
    repoId: "TEXT", phase: "TEXT", baseCommit: "TEXT", error: "TEXT",
    checks: "TEXT NOT NULL DEFAULT '[]'", files: "TEXT NOT NULL DEFAULT '[]'",
    hasPatch: "INTEGER NOT NULL DEFAULT 0", cancelRequested: "INTEGER NOT NULL DEFAULT 0",
    requestId: "TEXT",
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_request_id ON jobs(requestId);
      UPDATE jobs SET status = 'failed', error = 'Task predates repository registration. Submit it again with a repository.'
        WHERE status = 'queued' AND repoId IS NULL;
      CREATE TABLE IF NOT EXISTS logs (
        sequence INTEGER PRIMARY KEY, jobId TEXT NOT NULL, text TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS logs_job_sequence ON logs(jobId, sequence);
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return db;
}

export function getJob(db: DatabaseSync, id: string) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
}

export function claimJob(db: DatabaseSync) {
  return db.prepare(`
    UPDATE jobs SET status = 'running', phase = 'preparing'
    WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY rowid LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE status IN ('running', 'interrupted'))
    RETURNING *
  `).get() as Job | undefined;
}

export function publicJob(job: Job) {
  const { id, repoId, prompt, status, phase, baseCommit, error, createdAt, checks, files, hasPatch, cancelRequested } = job;
  return { id, repoId, prompt, status, phase, baseCommit, error, createdAt,
    checks: JSON.parse(checks), files: JSON.parse(files), hasPatch: Boolean(hasPatch),
    cancelRequested: Boolean(cancelRequested) };
}
