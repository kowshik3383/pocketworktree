import "reflect-metadata";
import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Module, Post, ForbiddenException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDirectory = resolve(process.env.POCKETWORKTREE_DATA_DIR ?? ".pocketworktree");
mkdirSync(dataDirectory, { recursive: true });
const database = new DatabaseSync(resolve(dataDirectory, "jobs.sqlite"));
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    createdAt TEXT NOT NULL
  ) STRICT;
`);

const selectJobs = database.prepare(
  "SELECT id, prompt, status, createdAt FROM jobs ORDER BY createdAt DESC, rowid DESC LIMIT 50",
);
const insertJob = database.prepare(
  "INSERT INTO jobs (id, prompt, status, createdAt) VALUES (?, ?, ?, ?)",
);

@Controller("api")
class DashboardController {
  @Get("health")
  health() {
    return { status: "ok" };
  }

  @Get("jobs")
  listJobs() {
    return selectJobs.all();
  }

  @Post("jobs")
  @HttpCode(202)
  createJob(@Body() input: unknown, @Headers("origin") origin?: string) {
    if (origin && !["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin)) {
      throw new ForbiddenException("Use the local PocketWorktree dashboard.");
    }

    const prompt = input && typeof input === "object" && "prompt" in input
      ? input.prompt
      : undefined;

    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) {
      throw new BadRequestException("Enter a task between 1 and 4,000 characters.");
    }

    const job = {
      id: randomUUID(),
      prompt: prompt.trim(),
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    insertJob.run(job.id, job.prompt, job.status, job.createdAt);
    return job;
  }
}

@Module({ controllers: [DashboardController] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(4000, "127.0.0.1");
}

void bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
