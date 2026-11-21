import { spawn } from "node:child_process";

export type CommandResult = { code: number | null; stdout: Buffer; stopped: boolean };

export function runCommand(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeout: number;
  onOutput?: (text: string) => void; maxOutput?: number;
}): Promise<CommandResult> {
  if (options.signal?.aborted) return Promise.resolve({ code: null, stdout: Buffer.alloc(0), stopped: true });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = false;
    let failure: Error | undefined;
    let escalation: NodeJS.Timeout | undefined;

    function signalGroup(signal: NodeJS.Signals) {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error;
      }
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      signalGroup("SIGTERM");
      escalation = setTimeout(() => signalGroup("SIGKILL"), 1500);
    }

    const timer = setTimeout(() => {
      failure = new Error(`Command timed out: ${command}`);
      stop();
    }, options.timeout);

    child.stdout.on("data", (chunk: Buffer) => {
      if (options.maxOutput !== undefined) {
        size += chunk.length;
        if (size > options.maxOutput) {
          failure ??= new Error(`Output too large: ${command}`);
          stop();
          return;
        }
        chunks.push(chunk);
      }
      options.onOutput?.(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => options.onOutput?.(chunk.toString("utf8")));
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      options.signal?.removeEventListener("abort", stop);
      signalGroup("SIGKILL");
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(chunks), stopped });
    });
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
  });
}
