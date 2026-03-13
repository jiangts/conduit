import { SqliteAgentQueueStore } from "../stores/sqlite/sqlite-agent-queue-store";
import { SqliteRunStore } from "../stores/sqlite/sqlite-run-store";

export interface StatusRunListQuery {
  limit: number;
  status?: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "canceled";
  project_id?: string;
}

export class ConduitStatusReader {
  private readonly runStore: SqliteRunStore;
  private readonly queueStore: SqliteAgentQueueStore;

  public constructor(dbPath: string) {
    this.runStore = new SqliteRunStore(dbPath);
    this.queueStore = new SqliteAgentQueueStore(dbPath, { initializeSchema: false });
  }

  public close(): void {
    this.queueStore.close();
    this.runStore.close();
  }

  public getRunQueueCounts() {
    return this.runStore.getQueueCounts();
  }

  public getRunStatusCounts() {
    return this.runStore.getRunStatusCounts();
  }

  public listRuns(query: StatusRunListQuery) {
    return this.runStore.listRuns({
      limit: query.limit,
      status: query.status,
      projectId: query.project_id,
    });
  }

  public async getThreadStateCounts() {
    return this.queueStore.getThreadStateCounts();
  }

  public async listRecentTerminalThreads(limit: number) {
    return this.queueStore.listRecentTerminalThreads(limit);
  }
}
