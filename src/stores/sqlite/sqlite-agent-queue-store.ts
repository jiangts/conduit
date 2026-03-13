import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

import {
  AgentQueueStore,
  EnqueueInput,
  FinishInput,
  OutputStream,
  QueueCounts,
  QueueClaimContext,
  QueueItem,
  ThreadRecord,
  ThreadState,
} from "../../types/agent-types";

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const DEFAULT_SQLITE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_queue (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  state TEXT NOT NULL,
  pid INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  ended_at TEXT,
  exit_code INTEGER,
  exit_signal TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_queue_state ON agent_queue(state);
CREATE INDEX IF NOT EXISTS idx_agent_queue_thread ON agent_queue(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_output (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_item_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  chunk TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(queue_item_id) REFERENCES agent_queue(id)
);
`.trim();

interface QueueRow {
  id: string;
  thread_id: string;
  prompt: string;
  working_directory: string;
  metadata_json: string;
  state: ThreadState;
}

interface ThreadRow extends QueueRow {
  pid: number | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  exit_signal: NodeJS.Signals | null;
}

export type ThreadStateCounts = Record<ThreadState, number>;

export interface SqliteAgentQueueStoreOptions {
  initializeSchema?: boolean;
  schemaSql?: string;
}

export class SqliteAgentQueueStore implements AgentQueueStore {
  private readonly db: Database.Database;
  private closed = false;

  public constructor(dbPath: string, options: SqliteAgentQueueStoreOptions = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);

    if (options.initializeSchema ?? true) {
      this.db.exec(options.schemaSql ?? DEFAULT_SQLITE_SCHEMA_SQL);
    }
  }

  public async enqueue(item: EnqueueInput): Promise<void> {
    this.db
      .prepare(
        `
INSERT INTO agent_queue (id, thread_id, prompt, working_directory, metadata_json, state)
VALUES (?, ?, ?, ?, ?, 'queued')
        `.trim(),
      )
      .run(item.id, item.threadId, item.prompt, item.workingDirectory, JSON.stringify(item.metadata));
  }

  public async claimNextQueued(context?: QueueClaimContext): Promise<QueueItem | null> {
    if (this.closed) {
      return null;
    }

    if (context?.policy?.dispatch && context.policy.dispatch !== "fifo") {
      throw new Error(`Unsupported dispatch policy: ${context.policy.dispatch}`);
    }

    while (true) {
      if (this.closed) {
        return null;
      }

      this.db.exec("BEGIN IMMEDIATE");

      try {
        const row = this.db
          .prepare(
            `
SELECT id, thread_id, prompt, working_directory, metadata_json, state
FROM agent_queue
WHERE state = 'queued'
ORDER BY created_at ASC, id ASC
LIMIT 1
            `.trim(),
          )
          .get() as unknown as QueueRow | undefined;

        if (!row) {
          this.db.exec("COMMIT");
          return null;
        }

        const updateResult = this.db
          .prepare(
            `
UPDATE agent_queue
SET state = 'starting', started_at = COALESCE(started_at, ${NOW_SQL})
WHERE id = ? AND state = 'queued'
            `.trim(),
          )
          .run(row.id) as { changes: number };

        this.db.exec("COMMIT");

        if (updateResult.changes === 0) {
          continue;
        }

        // Return local item as queued so lifecycle callbacks can emit queued -> starting.
        return {
          id: row.id,
          threadId: row.thread_id,
          prompt: row.prompt,
          workingDirectory: row.working_directory,
          metadata: this.parseMetadata(row.metadata_json),
          state: "queued",
        };
      } catch (error) {
        if (this.closed && this.isDatabaseNotOpenError(error)) {
          return null;
        }

        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  public async markState(id: string, state: ThreadState): Promise<void> {
    this.db
      .prepare(
        `
UPDATE agent_queue
SET state = ?,
    started_at = CASE
      WHEN ? IN ('starting', 'running') THEN COALESCE(started_at, ${NOW_SQL})
      ELSE started_at
    END
WHERE id = ?
        `.trim(),
      )
      .run(state, state, id);
  }

  public async attachPid(id: string, pid: number): Promise<void> {
    this.db
      .prepare(
        `
UPDATE agent_queue
SET pid = ?, started_at = COALESCE(started_at, ${NOW_SQL})
WHERE id = ?
        `.trim(),
      )
      .run(pid, id);
  }

  public async finish(id: string, result: FinishInput): Promise<void> {
    this.db
      .prepare(
        `
UPDATE agent_queue
SET state = ?,
    exit_code = ?,
    exit_signal = ?,
    ended_at = COALESCE(ended_at, ${NOW_SQL})
WHERE id = ?
        `.trim(),
      )
      .run(result.state, result.code, result.signal, id);
  }

  public async mergeMetadata(id: string, metadata: Record<string, string>): Promise<void> {
    const row = this.db
      .prepare(
        `
SELECT metadata_json
FROM agent_queue
WHERE id = ?
        `.trim(),
      )
      .get(id) as { metadata_json: string } | undefined;

    if (!row) {
      return;
    }

    const nextMetadata = {
      ...this.parseMetadata(row.metadata_json),
      ...metadata,
    };

    this.db
      .prepare(
        `
UPDATE agent_queue
SET metadata_json = ?
WHERE id = ?
        `.trim(),
      )
      .run(JSON.stringify(nextMetadata), id);
  }

  public async getQueueCounts(): Promise<QueueCounts> {
    const row = this.db
      .prepare(
        `
SELECT
  SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
  SUM(CASE WHEN state IN ('starting', 'running') THEN 1 ELSE 0 END) AS active
FROM agent_queue
        `.trim(),
      )
      .get() as unknown as { queued: number | null; active: number | null };

    return {
      queued: row.queued ?? 0,
      active: row.active ?? 0,
    };
  }

  public async getLatestByThreadId(threadId: string): Promise<ThreadRecord | null> {
    const row = this.db
      .prepare(
        `
SELECT
  id,
  thread_id,
  prompt,
  working_directory,
  metadata_json,
  state,
  pid,
  created_at,
  started_at,
  ended_at,
  exit_code,
  exit_signal
FROM agent_queue
WHERE thread_id = ?
ORDER BY created_at DESC, id DESC
LIMIT 1
        `.trim(),
      )
      .get(threadId) as unknown as ThreadRow | undefined;

    if (!row) return null;

    return {
      threadId: row.thread_id,
      queueItemId: row.id,
      state: row.state,
      pid: row.pid,
      prompt: row.prompt,
      metadata: this.parseMetadata(row.metadata_json),
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      exitCode: row.exit_code,
      exitSignal: row.exit_signal,
    };
  }

  public async getThreadStateCounts(): Promise<ThreadStateCounts> {
    const rows = this.db
      .prepare(
        `
SELECT state, COUNT(*) AS count
FROM agent_queue
GROUP BY state
        `.trim(),
      )
      .all() as Array<{ state: ThreadState; count: number }>;

    const counts: ThreadStateCounts = {
      queued: 0,
      starting: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const row of rows) {
      counts[row.state] = row.count;
    }
    return counts;
  }

  public async listRecentTerminalThreads(limit: number): Promise<ThreadRecord[]> {
    const rows = this.db
      .prepare(
        `
SELECT
  id,
  thread_id,
  prompt,
  working_directory,
  metadata_json,
  state,
  pid,
  created_at,
  started_at,
  ended_at,
  exit_code,
  exit_signal
FROM agent_queue
WHERE state IN ('completed', 'failed', 'cancelled')
ORDER BY COALESCE(ended_at, created_at) DESC, id DESC
LIMIT ?
        `.trim(),
      )
      .all(limit) as unknown as ThreadRow[];

    return rows.map((row) => ({
      threadId: row.thread_id,
      queueItemId: row.id,
      state: row.state,
      pid: row.pid,
      prompt: row.prompt,
      metadata: this.parseMetadata(row.metadata_json),
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      exitCode: row.exit_code,
      exitSignal: row.exit_signal,
    }));
  }

  public async appendOutput(id: string, stream: OutputStream, chunk: string): Promise<void> {
    this.db
      .prepare(
        `
INSERT INTO agent_output (queue_item_id, stream, chunk)
VALUES (?, ?, ?)
        `.trim(),
      )
      .run(id, stream, chunk);
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  private isDatabaseNotOpenError(error: unknown): boolean {
    return error instanceof TypeError && error.message.includes("database connection is not open");
  }

  private parseMetadata(metadataJson: string): Record<string, string> {
    try {
      const parsed = JSON.parse(metadataJson) as unknown;
      if (!parsed || typeof parsed !== "object") {
        return {};
      }

      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          out[key] = value;
        }
      }
      return out;
    } catch {
      return {};
    }
  }
}
