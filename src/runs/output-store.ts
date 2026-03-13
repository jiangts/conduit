import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { StoredRun } from "../types/run-types";

export interface OutputAppender {
  append(chunk: string): Promise<void>;
  flush(): Promise<void>;
}

class FileOutputAppender implements OutputAppender {
  private pending: Promise<void>;

  public constructor(private readonly path: string) {
    this.pending = writeFile(this.path, "", "utf8");
  }

  public append(chunk: string): Promise<void> {
    this.pending = this.pending.then(() => appendFile(this.path, chunk, "utf8"));
    return this.pending;
  }

  public flush(): Promise<void> {
    return this.pending;
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export class RunOutputStore {
  public readonly runsRoot: string;

  public constructor(stateDir: string) {
    this.runsRoot = join(stateDir, "runs");
  }

  public runDir(runId: string): string {
    return join(this.runsRoot, runId);
  }

  public runRecordPath(runId: string): string {
    return join(this.runDir(runId), "run.json");
  }

  public attemptDir(runId: string, attemptIndex: number): string {
    return join(this.runDir(runId), "attempts", String(attemptIndex));
  }

  public async initRun(runId: string): Promise<string> {
    const runDir = this.runDir(runId);
    await mkdir(runDir, { recursive: true });
    return this.runRecordPath(runId);
  }

  public async writeRunRecord(run: StoredRun): Promise<void> {
    await mkdir(this.runDir(run.run_id), { recursive: true });
    await writeFile(run.run_record_path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  }

  public async initAttempt(runId: string, attemptIndex: number): Promise<string> {
    const attemptDir = this.attemptDir(runId, attemptIndex);
    await mkdir(join(attemptDir, "checks"), { recursive: true });
    return attemptDir;
  }

  public checkOutputPaths(runId: string, attemptIndex: number, checkOrder: number, checkName: string) {
    const base = `${String(checkOrder).padStart(2, "0")}-${sanitizeSegment(checkName)}`;
    const checksDir = join(this.attemptDir(runId, attemptIndex), "checks");
    return {
      stdout: join(checksDir, `${base}.stdout.log`),
      stderr: join(checksDir, `${base}.stderr.log`),
    };
  }

  public createAppender(path: string): OutputAppender {
    return new FileOutputAppender(path);
  }
}
