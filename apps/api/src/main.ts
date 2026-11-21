import "reflect-metadata";
import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode,
  Module, NotFoundException, Param, Post, Query, Res,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response, NextFunction } from "express";
import { loadConfig } from "./config";
import { getJob, openStore, publicJob, type Job } from "./store";
import { Worker } from "./worker";

if (process.platform === "win32") throw new Error("Run the host on Linux, macOS, or WSL.");
const config = loadConfig();
const db = openStore(config.dataDir);
const worker = new Worker(db, config);
const sessions = new Map<string, number>();
const sessionLifetime = 12 * 60 * 60;
const attempts: number[] = [];
const digest = (value: string) => createHash("sha256").update(value).digest();
const passwordDigest = digest(config.password);
const jobIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function getSession(req: Request) {
  return req.headers.cookie?.split(";").map((item) => item.trim())
    .find((item) => item.startsWith("pwt_session="))?.slice("pwt_session=".length) ?? "";
}

function cookie(token: string, age: number) {
  return `pwt_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.secure ? "; Secure" : ""}`;
}

function auth(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && req.path === "/api/health") return next();
  if (req.method === "POST" && req.get("origin") !== config.origin) {
    return res.status(403).json({ message: "Dashboard origin does not match host configuration." });
  }

  if (req.method === "POST" && req.path === "/api/auth/login") {
    const now = Date.now();
    while (attempts.length && attempts[0] < now - 60_000) attempts.shift();
    if (attempts.length >= 10) return res.status(429).json({ message: "Try again in one minute." });
    attempts.push(now);
    if (typeof req.body?.password !== "string" ||
        !timingSafeEqual(digest(req.body.password), passwordDigest)) {
      return res.status(401).json({ message: "Incorrect password." });
    }

    for (const [token, expiry] of sessions) {
      if (expiry <= now) sessions.delete(token);
    }
    sessions.delete(getSession(req));
    const token = randomBytes(32).toString("hex");
    sessions.set(token, now + sessionLifetime * 1000);
    return res.setHeader("Set-Cookie", cookie(token, sessionLifetime)).status(204).end();
  }

  const token = getSession(req);
  if ((sessions.get(token) ?? 0) <= Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ message: "Sign in to PocketWorktree." });
  }
  if (req.method === "POST" && req.path === "/api/auth/logout") {
    sessions.delete(token);
    return res.setHeader("Set-Cookie", cookie("", 0)).status(204).end();
  }
  next();
}

function findJob(id: string) {
  const job = jobIdPattern.test(id) ? getJob(db, id) : undefined;
  if (!job) throw new NotFoundException("Task not found.");
  return job;
}

@Controller("api")
class DashboardController {
  @Get("health")
  health() {
    return { status: "ok" };
  }

  @Get("repos")
  repos() {
    return config.repos.map(({ id, name, baseRef }) => ({ id, name, baseRef }));
  }

  @Get("jobs")
  listJobs() {
    const jobs = db.prepare("SELECT * FROM jobs ORDER BY rowid DESC LIMIT 50").all() as Job[];
    const blocked = Boolean(db.prepare("SELECT id FROM jobs WHERE status = 'interrupted' LIMIT 1").get());
    return { jobs: jobs.map(publicJob), blocked };
  }

  @Post("jobs")
  @HttpCode(202)
  createJob(@Body() input: unknown) {
    if (!input || typeof input !== "object") throw new BadRequestException("Invalid task.");
    const { repoId, prompt, requestId } = input as Record<string, unknown>;
    if (typeof repoId !== "string" || typeof prompt !== "string" ||
        !prompt.trim() || prompt.length > 4000 ||
        typeof requestId !== "string" || !jobIdPattern.test(requestId)) {
      throw new BadRequestException("Choose a repository and enter a task between 1 and 4,000 characters.");
    }

    const prior = db.prepare("SELECT * FROM jobs WHERE requestId = ?").get(requestId) as Job | undefined;
    if (prior) {
      if (prior.repoId !== repoId || prior.prompt !== prompt.trim()) {
        throw new ConflictException("This submission ID was used for another task.");
      }
      return publicJob(prior);
    }
    if (!config.repos.some(({ id }) => id === repoId)) throw new BadRequestException("Unknown repository.");
    const id = randomUUID();
    const job = db.prepare(`
      INSERT INTO jobs (id, repoId, prompt, status, createdAt, requestId)
      VALUES (?, ?, ?, 'queued', ?, ?) RETURNING *
    `).get(id, repoId, prompt.trim(), new Date().toISOString(), requestId) as Job;
    return publicJob(job);
  }

  @Get("jobs/:id")
  job(@Param("id") id: string) {
    return publicJob(findJob(id));
  }

  @Get("jobs/:id/logs")
  logs(@Param("id") id: string, @Query("after") after = "0") {
    findJob(id);
    if (!/^\d{1,15}$/.test(after)) throw new BadRequestException("Invalid log cursor.");
    return db.prepare(`
      SELECT sequence, text FROM logs WHERE jobId = ? AND sequence > ?
      ORDER BY sequence LIMIT 100
    `).all(id, Number(after));
  }

  @Get("jobs/:id/diff")
  diff(@Param("id") id: string, @Query("download") download: string, @Res() response: Response) {
    if (!findJob(id).hasPatch) throw new NotFoundException("Patch unavailable.");
    const patch = readFileSync(join(config.dataDir, "jobs", id, "review.patch"));
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (download === "1") response.attachment(`pocketworktree-${id}.patch`);
    response.type("text/plain").send(patch);
  }

  @Post("jobs/:id/cancel")
  @HttpCode(202)
  cancel(@Param("id") id: string) {
    const job = findJob(id);
    if (job.status === "queued") {
      db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(id);
    } else if (job.status === "running") {
      db.prepare("UPDATE jobs SET cancelRequested = 1 WHERE id = ?").run(id);
      worker.cancel(id);
    }
    return publicJob(findJob(id));
  }
}

@Module({ controllers: [DashboardController] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser("json", { limit: "16kb" });
  app.use(auth);
  await app.listen(4000, "127.0.0.1");
  worker.start();

  let shutdownStarted = false;
  async function shutdown() {
    if (shutdownStarted) return;
    shutdownStarted = true;
    await worker.stop();
    await app.close();
    db.close();
  }
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

void bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
