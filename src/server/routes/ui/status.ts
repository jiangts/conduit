import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ConduitStatusReader } from "../../status-reader";
import type { ConduitConfig } from "../../../config";
import type { ThreadRecord } from "../../../types/agent-types";
import type { StoredAttempt, StoredRun } from "../../../types/run-types";
import { ConduitRunManager } from "../../../runs/manager";
import { HttpError } from "../../http-error";
import { renderOperatorHeader, renderOperatorShellStyles } from "./layout";

const StatusPageQuerySchema = z.object({
  runId: z.string().min(1).optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "timed_out", "canceled"]).optional(),
  project_id: z.string().min(1).optional(),
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestamp(value: string | null): string {
  if (!value) return "n/a";
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDurationMs(value: number | null): string {
  if (value === null) return "n/a";
  if (value < 1000) return `${value}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function formatUptime(startedAt: Date): string {
  const elapsedMs = Date.now() - startedAt.getTime();
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function pageHref(query: z.infer<typeof StatusPageQuerySchema>): string {
  const params = new URLSearchParams();
  if (query.runId) params.set("runId", query.runId);
  if (query.status) params.set("status", query.status);
  if (query.project_id) params.set("project_id", query.project_id);
  const qs = params.toString();
  return qs.length > 0 ? `/status?${qs}` : "/status";
}

function partialHref(path: string, query: z.infer<typeof StatusPageQuerySchema>): string {
  const params = new URLSearchParams();
  if (query.runId) params.set("runId", query.runId);
  if (query.status) params.set("status", query.status);
  if (query.project_id) params.set("project_id", query.project_id);
  const qs = params.toString();
  return qs.length > 0 ? `${path}?${qs}` : path;
}

function statusBadge(status: string): string {
  return `<span class="badge badge-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function threadSummary(thread: ThreadRecord, debug: boolean): string {
  const scope = thread.metadata.projectId ?? thread.metadata.conduitRunId ?? "unknown";
  const finalHref = thread.metadata.finalOutputPath ? `/chat/threads/${encodeURIComponent(thread.threadId)}/output/final` : null;
  const finalPreview = thread.metadata.finalMessagePreview?.trim() || "n/a";
  const usageSummary = thread.metadata.usageSummary?.trim() || "n/a";
  const exitMeta =
    thread.state === "completed"
      ? "exit 0"
      : debug
        ? `exit ${thread.exitCode ?? "null"}${thread.exitSignal ? ` / ${thread.exitSignal}` : ""}`
        : "details redacted";
  return `
    <tr>
      <td><code>${escapeHtml(thread.threadId)}</code></td>
      <td>${statusBadge(thread.state)}</td>
      <td>${escapeHtml(scope)}</td>
      <td>${escapeHtml(exitMeta)}</td>
      <td>${finalHref ? `<a href="${escapeHtml(finalHref)}" target="_blank" rel="noreferrer">${escapeHtml(finalPreview)}</a>` : escapeHtml(finalPreview)}</td>
      <td>${escapeHtml(usageSummary)}</td>
      <td>${escapeHtml(formatTimestamp(thread.endedAt ?? thread.createdAt))}</td>
    </tr>
  `;
}

function renderSummaryCard(input: {
  config: ConduitConfig;
  startedAt: Date;
  runQueue: { queued: number; active: number };
  runStatusCounts: Record<StoredRun["status"], number>;
  threadStateCounts: Record<"queued" | "starting" | "running" | "completed" | "failed" | "cancelled", number>;
}): string {
  const warnings: string[] = [];
  if (
    input.config.server.queue.maxQueuedRuns !== null &&
    input.runQueue.queued >= input.config.server.queue.maxQueuedRuns
  ) {
    warnings.push("run queue at configured capacity");
  }
  if (
    input.config.server.queue.maxActiveRuns !== null &&
    input.runQueue.active >= input.config.server.queue.maxActiveRuns
  ) {
    warnings.push("active run slots fully utilized");
  }

  return `
    <section class="card">
      <div class="section-head">
        <h2>Service Summary</h2>
        <span class="muted">refreshing every 4s</span>
      </div>
      <div class="metric-grid">
        <div class="metric"><span class="label">Uptime</span><strong>${escapeHtml(formatUptime(input.startedAt))}</strong></div>
        <div class="metric"><span class="label">Runs queued</span><strong>${input.runQueue.queued}</strong></div>
        <div class="metric"><span class="label">Runs active</span><strong>${input.runQueue.active}</strong></div>
        <div class="metric"><span class="label">Chat queued</span><strong>${input.threadStateCounts.queued}</strong></div>
        <div class="metric"><span class="label">Chat starting</span><strong>${input.threadStateCounts.starting}</strong></div>
        <div class="metric"><span class="label">Chat running</span><strong>${input.threadStateCounts.running}</strong></div>
      </div>
      <div class="stat-row">
        <span>Run limits: queued ${input.config.server.queue.maxQueuedRuns ?? "unbounded"}, active ${input.config.server.queue.maxActiveRuns ?? "unbounded"}</span>
        <span>Terminal runs: ${input.runStatusCounts.succeeded} succeeded, ${input.runStatusCounts.failed} failed, ${input.runStatusCounts.timed_out} timed out, ${input.runStatusCounts.canceled} canceled</span>
      </div>
      ${
        warnings.length > 0
          ? `<div class="warning">${escapeHtml(warnings.join(" | "))}</div>`
          : `<div class="muted">No queue pressure warnings.</div>`
      }
    </section>
  `;
}

function renderChatCard(input: {
  threadStateCounts: Record<"queued" | "starting" | "running" | "completed" | "failed" | "cancelled", number>;
  recentThreads: ThreadRecord[];
  debug: boolean;
}): string {
  return `
    <section class="card">
      <div class="section-head">
        <h2>Chat Queue</h2>
        <span class="muted">terminal outcomes include completed, failed, cancelled</span>
      </div>
      <div class="stat-row">
        <span>queued ${input.threadStateCounts.queued}</span>
        <span>starting ${input.threadStateCounts.starting}</span>
        <span>running ${input.threadStateCounts.running}</span>
        <span>completed ${input.threadStateCounts.completed}</span>
        <span>failed ${input.threadStateCounts.failed}</span>
        <span>cancelled ${input.threadStateCounts.cancelled}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Thread</th>
            <th>State</th>
            <th>Scope</th>
            <th>Exit</th>
            <th>Final</th>
            <th>Usage</th>
            <th>Ended</th>
          </tr>
        </thead>
        <tbody>
          ${
            input.recentThreads.length > 0
              ? input.recentThreads.map((thread) => threadSummary(thread, input.debug)).join("")
              : '<tr><td colspan="7" class="muted">No recent terminal chat threads.</td></tr>'
          }
        </tbody>
      </table>
    </section>
  `;
}

function renderRunsCard(input: {
  runs: StoredRun[];
  query: z.infer<typeof StatusPageQuerySchema>;
}): string {
  const filterLinks = [
    { label: "all", status: undefined },
    { label: "queued", status: "queued" as const },
    { label: "running", status: "running" as const },
    { label: "failed", status: "failed" as const },
    { label: "succeeded", status: "succeeded" as const },
  ];

  return `
    <section class="card">
      <div class="section-head">
        <h2>Runs</h2>
        <span class="muted">latest 20 runs</span>
      </div>
      <div class="filters">
        ${filterLinks
          .map((item) => {
            const href = pageHref({
              ...input.query,
              status: item.status,
              runId: input.query.runId,
            });
            const active = input.query.status === item.status || (!input.query.status && item.status === undefined);
            return `<a class="filter${active ? " active" : ""}" href="${escapeHtml(href)}">${escapeHtml(item.label)}</a>`;
          })
          .join("")}
      </div>
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Project</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Started</th>
            <th>Finished</th>
            <th>Failure</th>
          </tr>
        </thead>
        <tbody>
          ${
            input.runs.length > 0
              ? input.runs
                  .map((run) => {
                    const href = pageHref({
                      ...input.query,
                      runId: run.run_id,
                    });
                    const playgroundHref = `/playground?project_id=${encodeURIComponent(run.project_id)}&policy_id=${encodeURIComponent(run.policy_id)}&section=run`;
                    const rowClass = input.query.runId === run.run_id ? ' class="active-row"' : "";
                    return `
                      <tr${rowClass}>
                        <td><a href="${escapeHtml(href)}"><code>${escapeHtml(run.run_id)}</code></a></td>
                        <td>${escapeHtml(run.project_id)}</td>
                        <td>${statusBadge(run.status)}</td>
                        <td>${run.current_attempt_index}/${run.max_attempts}</td>
                        <td>${escapeHtml(formatTimestamp(run.started_at ?? run.created_at))}</td>
                        <td>${escapeHtml(formatTimestamp(run.finished_at))}</td>
                        <td>${escapeHtml(run.failure_summary ?? "n/a")} <span class="muted"><a href="${escapeHtml(playgroundHref)}">playground</a></span></td>
                      </tr>
                    `;
                  })
                  .join("")
              : '<tr><td colspan="7" class="muted">No runs match the current filter.</td></tr>'
          }
        </tbody>
      </table>
    </section>
  `;
}

function renderCheckRow(runId: string, attemptIndex: number, check: NonNullable<ReturnType<ConduitRunManager["getAttempts"]>[number]>["check_results"][number]): string {
  const stdoutHref = check.stdout_path ? `/runs/${encodeURIComponent(runId)}/attempts/${attemptIndex}/output/checks/${encodeURIComponent(check.name)}?stream=stdout` : null;
  const stderrHref = check.stderr_path ? `/runs/${encodeURIComponent(runId)}/attempts/${attemptIndex}/output/checks/${encodeURIComponent(check.name)}?stream=stderr` : null;
  return `
    <tr>
      <td>${escapeHtml(check.name)}</td>
      <td>${check.passed ? statusBadge("passed") : statusBadge(check.failure_effective ? "failure_effective" : "ignored")}</td>
      <td>${escapeHtml(check.exit_code === null ? "null" : String(check.exit_code))}</td>
      <td>${escapeHtml(formatDurationMs(check.duration_ms))}</td>
      <td class="links">
        ${stdoutHref ? `<a href="${escapeHtml(stdoutHref)}" target="_blank" rel="noreferrer">stdout</a>` : '<span class="muted">stdout</span>'}
        ${stderrHref ? `<a href="${escapeHtml(stderrHref)}" target="_blank" rel="noreferrer">stderr</a>` : '<span class="muted">stderr</span>'}
      </td>
    </tr>
  `;
}

function renderAttempt(attempt: StoredAttempt & { check_results: ReturnType<ConduitRunManager["getAttempts"]>[number]["check_results"] }, runId: string): string {
  const agentFinal = `/runs/${encodeURIComponent(runId)}/attempts/${attempt.attempt_index}/output/agent/final`;
  const agentStdout = `/runs/${encodeURIComponent(runId)}/attempts/${attempt.attempt_index}/output/agent?stream=stdout`;
  const agentStderr = `/runs/${encodeURIComponent(runId)}/attempts/${attempt.attempt_index}/output/agent?stream=stderr`;
  return `
    <article class="attempt">
      <div class="attempt-head">
        <h3>Attempt ${attempt.attempt_index}</h3>
        <span>${statusBadge(attempt.status)}</span>
      </div>
      <div class="stat-row">
        <span>runner ${escapeHtml(attempt.runner.provider)}${attempt.runner.model ? ` / ${escapeHtml(attempt.runner.model)}` : ""}</span>
        <span>duration ${escapeHtml(formatDurationMs(attempt.duration_ms))}</span>
        <span>started ${escapeHtml(formatTimestamp(attempt.started_at))}</span>
        <span>finished ${escapeHtml(formatTimestamp(attempt.finished_at))}</span>
      </div>
      <div class="links">
        <a href="${escapeHtml(agentFinal)}" target="_blank" rel="noreferrer">agent final</a>
        <a href="${escapeHtml(agentStdout)}" target="_blank" rel="noreferrer">agent stdout</a>
        <a href="${escapeHtml(agentStderr)}" target="_blank" rel="noreferrer">agent stderr</a>
      </div>
      <div class="muted">Failure summary: ${escapeHtml(attempt.failure_summary ?? "n/a")}</div>
      <table>
        <thead>
          <tr>
            <th>Check</th>
            <th>Outcome</th>
            <th>Exit</th>
            <th>Duration</th>
            <th>Logs</th>
          </tr>
        </thead>
        <tbody>
          ${
            attempt.check_results.length > 0
              ? attempt.check_results.map((check) => renderCheckRow(runId, attempt.attempt_index, check)).join("")
              : '<tr><td colspan="5" class="muted">No checks recorded for this attempt.</td></tr>'
          }
        </tbody>
      </table>
    </article>
  `;
}

function renderRunDetail(run: StoredRun, attempts: Array<StoredAttempt & { check_results: ReturnType<ConduitRunManager["getAttempts"]>[number]["check_results"] }>): string {
  const playgroundHref = `/playground?project_id=${encodeURIComponent(run.project_id)}&policy_id=${encodeURIComponent(run.policy_id)}&section=run`;
  return `
    <section class="card">
      <div class="section-head">
        <h2>Run Detail</h2>
        <div class="links">
          <a class="filter" href="${escapeHtml(playgroundHref)}">Playground</a>
          <a class="filter" href="/runs/${encodeURIComponent(run.run_id)}?include=attempts" target="_blank" rel="noreferrer">JSON</a>
        </div>
      </div>
      <div class="stat-row">
        <span><code>${escapeHtml(run.run_id)}</code></span>
        <span>${statusBadge(run.status)}</span>
        <span>project ${escapeHtml(run.project_id)}</span>
        <span>policy ${escapeHtml(run.policy_id)}</span>
        <span>attempts ${run.current_attempt_index}/${run.max_attempts}</span>
      </div>
      <div class="stat-row">
        <span>created ${escapeHtml(formatTimestamp(run.created_at))}</span>
        <span>started ${escapeHtml(formatTimestamp(run.started_at))}</span>
        <span>finished ${escapeHtml(formatTimestamp(run.finished_at))}</span>
      </div>
      <div class="muted">Failure summary: ${escapeHtml(run.failure_summary ?? "n/a")}</div>
      ${attempts.length > 0 ? attempts.map((attempt) => renderAttempt(attempt, run.run_id)).join("") : '<div class="muted">No attempts recorded yet.</div>'}
    </section>
  `;
}

const HtmlQuerySchema = StatusPageQuerySchema;

export function registerStatusRoutes(
  app: FastifyInstance,
  config: ConduitConfig,
  runManager: ConduitRunManager,
  statusReader: ConduitStatusReader,
  startedAt: Date,
): void {
  async function buildSummaryHtml() {
    const [threadStateCounts, runStatusCounts] = await Promise.all([
      statusReader.getThreadStateCounts(),
      Promise.resolve(statusReader.getRunStatusCounts()),
    ]);
    return renderSummaryCard({
      config,
      startedAt,
      runQueue: statusReader.getRunQueueCounts(),
      runStatusCounts,
      threadStateCounts,
    });
  }

  app.get("/status", { schema: { hide: true, querystring: HtmlQuerySchema } }, async (request, reply) => {
    const query = request.query as z.infer<typeof HtmlQuerySchema>;
    reply.type("text/html; charset=utf-8");
    return `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Conduit Status</title>
          <script src="https://unpkg.com/htmx.org@2.0.4"></script>
          <style>
            ${renderOperatorShellStyles()}
            h2 { font-size: 1.15rem; }
            h3 { font-size: 1rem; }
            code { font-family: "SFMono-Regular", Menlo, monospace; font-size: 0.9em; }
            .grid { display: grid; gap: 16px; }
            .section-head, .attempt-head, .stat-row, .filters, .links { flex-wrap: wrap; gap: 10px 14px; align-items: center; justify-content: space-between; }
            .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 14px 0; }
            .metric { padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: rgba(255,255,255,0.7); }
            .label, .muted { color: var(--muted); font-size: 0.92rem; }
            .metric strong { display: block; margin-top: 4px; font-size: 1.2rem; }
            .warning { margin-top: 14px; padding: 10px 12px; border-radius: 12px; background: #fff7ed; border: 1px solid #fdba74; color: var(--warn); }
            .badge { display: inline-flex; padding: 3px 8px; border-radius: 999px; font-size: 0.8rem; border: 1px solid currentColor; }
            .badge-queued, .badge-starting, .badge-running { color: var(--accent); }
            .badge-succeeded, .badge-completed, .badge-passed { color: #166534; }
            .badge-failed, .badge-timed_out, .badge-canceled, .badge-cancelled, .badge-failure_effective { color: var(--danger); }
            .badge-ignored { color: #92400e; }
            table { width: 100%; border-collapse: collapse; margin-top: 14px; }
            th, td { text-align: left; padding: 10px 8px; border-top: 1px solid var(--line); vertical-align: top; }
            th { color: var(--muted); font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
            a { color: #115e59; text-decoration: none; }
            a:hover { text-decoration: underline; }
            .filter { display: inline-flex; align-items: center; padding: 6px 10px; border-radius: 999px; border: 1px solid var(--line); background: rgba(255,255,255,0.75); }
            .filter.active { background: #134e4a; color: white; border-color: #134e4a; }
            .active-row td { background: rgba(19, 78, 74, 0.08); }
            .attempt { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
          </style>
        </head>
        <body>
          <main>
            ${renderOperatorHeader({
              current: "status",
              title: "Conduit Status",
              description: "Operator dashboard for queue state, run lifecycle, attempts, and logs.",
            })}
            <div class="grid">
              <div id="status-summary" hx-get="${escapeHtml(partialHref("/status/partials/summary", query))}" hx-trigger="load, every 4s" hx-swap="innerHTML"></div>
              <div id="status-chat" hx-get="${escapeHtml(partialHref("/status/partials/chat", query))}" hx-trigger="load, every 4s" hx-swap="innerHTML"></div>
              <div id="status-runs" hx-get="${escapeHtml(partialHref("/status/partials/runs", query))}" hx-trigger="load, every 4s" hx-swap="innerHTML"></div>
              ${
                query.runId
                  ? `<div id="status-run-detail" hx-get="${escapeHtml(`/status/partials/runs/${encodeURIComponent(query.runId)}`)}" hx-trigger="load, every 4s" hx-swap="innerHTML"></div>`
                  : ""
              }
            </div>
          </main>
        </body>
      </html>
    `;
  });

  app.get("/status/partials/summary", { schema: { hide: true } }, async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return buildSummaryHtml();
  });

  app.get("/status/partials/chat", { schema: { hide: true } }, async (_request, reply) => {
    const [threadStateCounts, recentThreads] = await Promise.all([
      statusReader.getThreadStateCounts(),
      statusReader.listRecentTerminalThreads(10),
    ]);
    reply.type("text/html; charset=utf-8");
    return renderChatCard({
      threadStateCounts,
      recentThreads,
      debug: config.server.debug,
    });
  });

  app.get("/status/partials/runs", { schema: { hide: true, querystring: HtmlQuerySchema } }, async (request, reply) => {
    const query = request.query as z.infer<typeof HtmlQuerySchema>;
    const result = statusReader.listRuns({
      limit: 20,
      status: query.status,
      project_id: query.project_id,
    });
    reply.type("text/html; charset=utf-8");
    return renderRunsCard({
      runs: result.runs,
      query,
    });
  });

  app.get("/status/partials/runs/:runId", { schema: { hide: true } }, async (request, reply) => {
    const params = request.params as { runId: string };
    const run = runManager.getRun(params.runId);
    if (!run) {
      throw new HttpError(404, `Run "${params.runId}" not found`);
    }
    const attempts = runManager.getAttempts(params.runId);
    reply.type("text/html; charset=utf-8");
    return renderRunDetail(run, attempts);
  });
}
