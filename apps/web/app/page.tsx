"use client";

import { useEffect, useState, type FormEvent } from "react";

type Job = {
  id: string;
  prompt: string;
  status: "queued";
  createdAt: string;
};

export default function Dashboard() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadJobs() {
      try {
        const response = await fetch("/api/jobs", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Could not load the queue. Check that the API is running.");
        const previousJobs: Job[] = await response.json();
        setJobs((current) => current ?? previousJobs);
      } catch {
        if (!controller.signal.aborted) {
          setError("Could not load the queue. Check that the API is running and reload.");
        }
      }
    }

    void loadJobs();
    return () => controller.abort();
  }, []);

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim() || submitting) return;

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!response.ok) throw new Error("Task submission failed.");
      setPrompt("");

      const history = await fetch("/api/jobs", { cache: "no-store" });
      if (!history.ok) {
        setError("Task queued. Reload to refresh the job list.");
        return;
      }
      setJobs(await history.json());
    } catch {
      setError("Could not confirm the queue update. Reload before submitting again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <header>
        <h1>PocketWorktree</h1>
        <p>Queue coding tasks on this machine.</p>
      </header>
      <form onSubmit={submitTask}>
        <label htmlFor="prompt">What should the agent change?</label>
        <textarea
          id="prompt"
          rows={5}
          maxLength={4000}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Fix the selected ward chip styling using the shared design tokens."
          required
        />
        <button disabled={submitting || !prompt.trim()}>
          {submitting ? "Queuing…" : "Queue task"}
        </button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      <section aria-labelledby="recent-jobs">
        <h2 id="recent-jobs">Recent jobs</h2>
        <p>Tasks are saved locally. Agent execution is pending implementation.</p>
        {jobs === null && !error && <p>Loading jobs…</p>}
        {jobs?.length === 0 && <p>No tasks queued yet.</p>}
        <ul>
          {jobs?.map((job) => (
            <li key={job.id}>
              <span className="status">{job.status}</span>
              <p>{job.prompt}</p>
              <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
