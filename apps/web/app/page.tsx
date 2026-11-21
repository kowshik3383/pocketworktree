"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type Repo = { id: string; name: string; baseRef: string };
type Check = { name: string; code: number | null; error?: string };
type Job = {
  id: string; repoId: string; prompt: string; status: string; phase: string | null;
  createdAt: string; baseCommit: string | null; error: string | null;
  checks: Check[]; files: string[]; hasPatch: boolean; cancelRequested: boolean;
};
type Queue = { jobs: Job[]; blocked: boolean };
type Log = { sequence: number; text: string };

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request(path: string, options?: RequestInit) {
  const response = await fetch("/api" + path, { cache: "no-store", ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, typeof body.message === "string" ? body.message : "Request failed.");
  }
  return response;
}

const post = (path: string, body: object = {}) => request(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

function JobDetail({ job, onCancel, onRetry, onError }: {
  job: Job; onCancel: () => void; onRetry: () => void; onError: (error: unknown) => void;
}) {
  const [logs, setLogs] = useState("");
  const [patch, setPatch] = useState<string>();
  const [loadingPatch, setLoadingPatch] = useState(false);
  const cursor = useRef(0);
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const shouldPoll = job.status === "queued" || job.status === "running";
    async function load() {
      let delay = 2000;
      let more = false;
      try {
        const response = await request(`/jobs/${job.id}/logs?after=${cursor.current}`, { signal: controller.signal });
        const entries: Log[] = await response.json();
        if (controller.signal.aborted) return;
        if (entries.length) {
          cursor.current = entries[entries.length - 1].sequence;
          setLogs((previous) => previous + entries.map(({ text }) => text).join(""));
        }
        more = entries.length === 100;
        if (more) delay = 20;
      } catch (error) {
        if (!controller.signal.aborted) onErrorRef.current(error);
      }
      if (!controller.signal.aborted && (shouldPoll || more)) timer = setTimeout(load, delay);
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job.id, job.status]);

  async function loadPatch() {
    setLoadingPatch(true);
    try {
      const body = await (await request(`/jobs/${job.id}/diff`)).text();
      setPatch(body.length > 200_000 ? body.slice(0, 200_000) + "\n\nPreview truncated. Download the full patch below." : body);
    } catch (error) { onError(error); }
    finally { setLoadingPatch(false); }
  }

  const active = job.status === "queued" || job.status === "running";
  return (
    <section aria-labelledby="job-detail">
      <h2 id="job-detail">Task details</h2>
      <p className="status">{job.status}{job.phase && ` · ${job.phase}`}</p>
      <p className="prompt">{job.prompt}</p>
      {job.baseCommit && <p>Base commit <code>{job.baseCommit.slice(0, 12)}</code></p>}
      {job.error && <p className="error">{job.error}</p>}
      {active && <button type="button" className="secondary" disabled={job.cancelRequested} onClick={onCancel}>
        {job.cancelRequested ? "Stopping…" : "Cancel task"}
      </button>}
      {!active && job.repoId && <button type="button" className="secondary" onClick={onRetry}>Use prompt again</button>}
      {job.checks.length > 0 && <><h3>Checks</h3><ul>{job.checks.map((check, index) =>
        <li key={index}>{check.name} · {check.code === 0 ? "Passed" : check.error ?? `Exit code ${check.code}`}</li>
      )}</ul></>}
      <h3>Activity</h3>
      {logs ? <pre tabIndex={0}>{logs}</pre> : <p>No activity recorded yet.</p>}
      {job.hasPatch && <>
        <h3>{job.status === "completed" ? "Git patch" : "Partial Git patch"}</h3>
        {job.files.length ? <ul className="paths">{job.files.map((file) => <li key={file}>{file}</li>)}</ul> : <p>No file changes.</p>}
        <div className="actions">
          {patch === undefined && <button type="button" onClick={() => void loadPatch()} disabled={loadingPatch}>
            {loadingPatch ? "Loading…" : "View diff"}
          </button>}
          <a href={`/api/jobs/${job.id}/diff?download=1`} download>Download patch</a>
        </div>
        {patch && <pre tabIndex={0}>{patch}</pre>}
      </>}
    </section>
  );
}

export default function Dashboard() {
  const [signedIn, setSignedIn] = useState<boolean>();
  const [password, setPassword] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [queue, setQueue] = useState<Queue>({ jobs: [], blocked: false });
  const [repoId, setRepoId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<Job>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const submission = useRef<{ repoId: string; prompt: string; requestId: string } | null>(null);
  const generation = useRef(0);
  const jobId = selected?.id;

  function report(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      setSignedIn(false);
      setSelected(undefined);
      setQueue({ jobs: [], blocked: false });
    }
    setError(error instanceof Error ? error.message : "Request failed.");
  }

  useEffect(() => {
    if (signedIn === false) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const started = generation.current;
      try {
        const options = { signal: controller.signal };
        const [repoResponse, queueResponse, jobResponse] = await Promise.all([
          request("/repos", options), request("/jobs", options),
          jobId ? request(`/jobs/${jobId}`, options) : undefined,
        ]);
        const [repoList, latestQueue, job] = await Promise.all([
          repoResponse.json() as Promise<Repo[]>, queueResponse.json() as Promise<Queue>,
          jobResponse?.json() as Promise<Job> | undefined,
        ]);
        if (controller.signal.aborted || started !== generation.current) return;
        setSignedIn(true);
        setRepos(repoList);
        setRepoId((value) => repoList.some((repo) => repo.id === value) ? value : repoList[0]?.id ?? "");
        setQueue(latestQueue);
        if (job) setSelected(job);
      } catch (error) {
        if (controller.signal.aborted || started !== generation.current) return;
        if (error instanceof ApiError && error.status === 401 && signedIn === undefined) setSignedIn(false);
        else report(error);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 2500);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [signedIn, jobId]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await post("/auth/login", { password });
      setPassword("");
      setSignedIn(true);
    } catch (error) { report(error); }
    finally { setPending(false); }
  }

  async function signOut() {
    try {
      await post("/auth/logout");
      generation.current++;
      setSignedIn(false);
      setQueue({ jobs: [], blocked: false });
      setSelected(undefined);
      setPrompt("");
      submission.current = null;
      setError("");
    } catch (error) { report(error); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !repoId || !prompt.trim()) return;
    const previous = submission.current;
    const payload = previous && previous.repoId === repoId && previous.prompt === prompt
      ? previous
      : { repoId, prompt, requestId: crypto.randomUUID() };
    submission.current = payload;
    setPending(true);
    setError("");
    try {
      const job: Job = await (await post("/jobs", payload)).json();
      generation.current++;
      setSelected(job);
      setPrompt("");
      submission.current = null;
    } catch (error) { report(error); }
    finally { setPending(false); }
  }

  async function cancel(job: Job) {
    try {
      const updated: Job = await (await post(`/jobs/${job.id}/cancel`)).json();
      generation.current++;
      setSelected((current) => current?.id === job.id ? updated : current);
    } catch (error) { report(error); }
  }

  const repo = repos.find(({ id }) => id === repoId);

  return (
    <main>
      <header>
        <h1>PocketWorktree</h1>
        <p>Run local coding tasks and review their Git patches.</p>
        {signedIn && <button type="button" className="secondary" onClick={() => void signOut()}>Sign out</button>}
      </header>
      {error && <p role="alert" className="error">{error}</p>}
      {signedIn === undefined && <p>Connecting to the local API…</p>}
      {signedIn === false && <form onSubmit={signIn}>
        <label htmlFor="password">Owner password</label>
        <input id="password" type="password" autoComplete="current-password" value={password}
          onChange={(event) => setPassword(event.target.value)} required />
        <button disabled={pending}>Sign in</button>
      </form>}
      {signedIn && <>
        {queue.blocked && <p role="alert" className="error">The queue is paused after a host interruption. Check the host before resuming.</p>}
        <form onSubmit={submit}>
          <label htmlFor="repo">Repository</label>
          <select id="repo" value={repoId} onChange={(event) => setRepoId(event.target.value)} disabled={pending}>
            {repos.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
          {repo && <p>Base branch <code>{repo.baseRef.replace("refs/heads/", "")}</code></p>}
          <label htmlFor="prompt">What should OpenCode change?</label>
          <textarea id="prompt" rows={5} maxLength={4000} value={prompt} disabled={pending}
            onChange={(event) => setPrompt(event.target.value)} required />
          <button disabled={pending || !repoId || !prompt.trim()}>Queue task</button>
        </form>
        {selected && <JobDetail key={selected.id} job={selected} onError={report} onCancel={() => void cancel(selected)}
          onRetry={() => { setPrompt(selected.prompt); setRepoId(selected.repoId); document.getElementById("prompt")?.focus(); }} />}
        <section aria-labelledby="recent-jobs">
          <h2 id="recent-jobs">Recent jobs</h2>
          {!queue.jobs.length && <p>No tasks queued yet.</p>}
          <ul className="history">{queue.jobs.map((job) =>
            <li key={job.id}><button type="button" onClick={() => setSelected(job)} aria-pressed={job.id === jobId}>
              <span className="status">{job.status}</span>
              <span className="prompt">{job.prompt}</span>
              <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>
            </button></li>
          )}</ul>
        </section>
      </>}
    </main>
  );
}
