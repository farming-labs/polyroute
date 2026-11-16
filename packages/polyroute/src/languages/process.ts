import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { PolyrouteError } from "../errors.js";

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** The `TOOLCHAIN_MISSING` message to throw when `command` isn't on PATH. */
  missing: string;
}

/** Runs a toolchain command and collects its output. */
export function runTool(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new PolyrouteError("TOOLCHAIN_MISSING", options.missing, { cause: error })
          : error,
      );
    });
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

/** Runs tasks one at a time, in call order, whether or not earlier ones failed. */
export function createQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
}

export function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}
