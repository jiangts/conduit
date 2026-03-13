import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ConduitConfig } from "../../../config";
import { listProjectPolicies, listProjects } from "../../../config";
import { renderOperatorHeader, renderOperatorShellStyles } from "./layout";

const PolicyQuerySchema = z.object({
  project_id: z.string().min(1).optional(),
  policy_id: z.string().min(1).optional(),
  section: z.enum(["chat", "run"]).optional(),
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderProjectOptions(
  projects: Array<{ project_id: string }>,
  selectedProjectId: string | null,
): string {
  if (projects.length === 0) {
    return '<option value="">No projects found</option>';
  }

  return projects
    .map((project) => {
      const selected = project.project_id === selectedProjectId ? " selected" : "";
      return `<option value="${escapeHtml(project.project_id)}"${selected}>${escapeHtml(project.project_id)}</option>`;
    })
    .join("");
}

function renderProjectSelect(input: {
  id?: string;
  projects: Array<{ project_id: string }>;
  selectedProjectId: string | null;
  attributes?: string;
}): string {
  const disabled = input.projects.length === 0 ? " disabled" : "";
  const idAttr = input.id ? ` id="${escapeHtml(input.id)}"` : "";
  const extraAttributes = input.attributes ? ` ${input.attributes}` : "";
  return `<select${idAttr} name="project_id"${disabled}${extraAttributes}>${renderProjectOptions(
    input.projects,
    input.selectedProjectId,
  )}</select>`;
}

function renderPolicyField(
  projectId: string | null,
  policies: Array<{ policy_id: string; task_id: string }>,
  selectedPolicyId: string | null,
): string {
  if (!projectId) {
    return `
      <label>
        Policy
        <select name="policy_id" disabled>
          <option value="">No project selected</option>
        </select>
      </label>
    `;
  }

  if (policies.length === 0) {
    return `
      <label>
        Policy
        <select name="policy_id" disabled>
          <option value="">No policies found</option>
        </select>
      </label>
      <small class="muted">No repo-local policies were discovered for <code>${escapeHtml(projectId)}</code>.</small>
    `;
  }

  return `
    <label>
      Policy
      <select name="policy_id">
        ${policies
          .map(
            (policy) =>
              `<option value="${escapeHtml(policy.policy_id)}"${
                policy.policy_id === selectedPolicyId ? " selected" : ""
              }>${escapeHtml(policy.policy_id)} (${escapeHtml(policy.task_id)})</option>`,
          )
          .join("")}
      </select>
    </label>
  `;
}

export function registerPlaygroundRoutes(app: FastifyInstance, config: ConduitConfig): void {
  app.get("/playground", { schema: { hide: true, querystring: PolicyQuerySchema } }, async (request, reply) => {
    const query = request.query as z.infer<typeof PolicyQuerySchema>;
    const projects = await listProjects(config);
    const requestedProjectId = query.project_id ?? null;
    const selectedProjectId = projects.some((project) => project.project_id === requestedProjectId)
      ? requestedProjectId
      : (projects[0]?.project_id ?? null);
    const defaultPolicies = selectedProjectId ? await listProjectPolicies(config, selectedProjectId) : [];
    const requestedPolicyId = query.policy_id ?? null;
    const selectedPolicyId = defaultPolicies.some((policy) => policy.policy_id === requestedPolicyId)
      ? requestedPolicyId
      : (defaultPolicies[0]?.policy_id ?? null);
    const selectedSection = query.section === "run" ? "run" : "chat";
    const hasProjects = projects.length > 0;
    const hasPolicies = defaultPolicies.length > 0;
    reply.type("text/html; charset=utf-8");
    return `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Conduit Playground</title>
          <script src="https://unpkg.com/htmx.org@2.0.4"></script>
          <script src="https://unpkg.com/json5@2/dist/index.min.js"></script>
          <style>
            ${renderOperatorShellStyles()}
            code, textarea, input, select, button { font: inherit; }
            .result-card { padding: 12px 14px; }
            form { display: flex; flex-direction: column; gap: 12px; margin-top: 14px; }
            label { display: flex; flex-direction: column; gap: 6px; font-size: 0.95rem; }
            input, select, textarea { width: 100%; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: rgba(255,255,255,0.82); }
            textarea { min-height: 150px; resize: vertical; font-family: "SFMono-Regular", Menlo, monospace; font-size: 0.9rem; }
            button { border: 0; border-radius: 999px; padding: 10px 16px; background: #134e4a; color: white; cursor: pointer; }
            button[disabled] { opacity: 0.65; }
            .actions { align-items: center; justify-content: space-between; flex-wrap: wrap; }
            .error { color: var(--danger); }
            .playground-stack { display: flex; flex-direction: column; gap: 16px; }
            .accordion { overflow: hidden; }
            .accordion summary { display: flex; align-items: center; justify-content: space-between; cursor: pointer; list-style: none; font-size: 1.15rem; font-weight: 600; }
            .accordion summary::-webkit-details-marker { display: none; }
            .accordion summary::after { content: "+"; color: var(--muted); font-size: 1.25rem; }
            .accordion[open] summary::after { content: "−"; }
            .accordion-copy { margin-top: 8px; }
          </style>
        </head>
        <body>
          <main>
            ${renderOperatorHeader({
              current: "playground",
              title: "Conduit Playground",
              description: "Ad hoc operator entrypoint for chats and deterministic runs.",
              trailing: `<span class="pill">default runner ${escapeHtml(config.defaultRunner)}</span>`,
            })}
            <div class="playground-stack">
            <details class="card accordion"${selectedSection === "chat" ? " open" : ""} data-playground-section="chat">
                <summary>Start Chat</summary>
                <p class="muted accordion-copy">Uses the configured default runner unless server defaults change.</p>
                <form data-playground-form="chat" data-result-target="playground-chat-result">
                  <label>
                    Project
                    ${renderProjectSelect({
                      id: "playground-chat-project",
                      projects,
                      selectedProjectId,
                      attributes: 'data-project-select="chat"',
                    })}
                  </label>
                  <label>
                    Prompt
                    <textarea name="prompt" placeholder="Describe the coding task"></textarea>
                  </label>
                  <div class="actions">
                    <button type="submit"${hasProjects ? "" : " disabled"}>Start chat</button>
                  </div>
                </form>
                <div id="playground-chat-result" class="result-stack"></div>
            </details>
            <details class="card accordion"${selectedSection === "run" ? " open" : ""} data-playground-section="run">
                <summary>Start Run</summary>
                <p class="muted accordion-copy">Project and repo-local policy are selected server-side. Input accepts JSON5 and is normalized before submit.</p>
                <form data-playground-form="run" data-result-target="playground-run-result">
                  <label>
                    Project
                    ${renderProjectSelect({
                      id: "playground-run-project",
                      projects,
                      selectedProjectId,
                      attributes:
                        'data-project-select="run" hx-get="/playground/partials/run-policy" hx-trigger="change" hx-target="#playground-run-policy" hx-include="#playground-run-project, #playground-run-policy select[name=\'policy_id\']"',
                    })}
                  </label>
                  <div id="playground-run-policy">
                    ${renderPolicyField(selectedProjectId, defaultPolicies, selectedPolicyId)}
                  </div>
                  <label>
                    Input JSON
                    <textarea name="input" placeholder="{issue: 'invoice rounding', retries: 2}">{}</textarea>
                  </label>
                  <small class="muted">JSON5 is accepted here. Example: <code>{issue: 'invoice rounding', retries: 2, // optional note
}</code></small>
                  <div class="actions">
                    <button type="submit"${hasProjects && hasPolicies ? "" : " disabled"}>Create run</button>
                  </div>
                </form>
                <div id="playground-run-result" class="result-stack"></div>
            </details>
            </div>
          </main>
          <script>
            function escapeHtml(value) {
              return String(value)
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;')
                .replaceAll('"', '&quot;')
                .replaceAll("'", '&#39;');
            }

            function renderResultCard(title, body) {
              return '<section class="card result-card"><h3>' + escapeHtml(title) + '</h3>' + body + '</section>';
            }

            function formatUsage(usage) {
              if (!usage || typeof usage !== 'object') return '';
              const parts = [];
              if (typeof usage.inputTokens === 'number') parts.push('in ' + usage.inputTokens);
              if (typeof usage.outputTokens === 'number') parts.push('out ' + usage.outputTokens);
              if (typeof usage.cachedInputTokens === 'number') parts.push('cached ' + usage.cachedInputTokens);
              if (typeof usage.totalTokens === 'number') parts.push('total ' + usage.totalTokens);
              return parts.join(' | ');
            }

            async function submitPlaygroundForm(form, endpoint) {
              const button = form.querySelector('button[type="submit"]');
              const resultTarget = document.getElementById(form.dataset.resultTarget);
              if (!resultTarget) return;
              button.disabled = true;
              try {
                let payload;
                if (form.dataset.playgroundForm === 'run') {
                  const inputField = form.querySelector('textarea[name="input"]');
                  if (!(inputField instanceof HTMLTextAreaElement)) {
                    throw new Error('Missing run input field');
                  }
                  const parsedInput = JSON5.parse(inputField.value);
                  if (!parsedInput || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) {
                    throw new Error('Input must be a JSON object');
                  }
                  payload = {
                    project_id: String(form.querySelector('[name="project_id"]').value),
                    policy_id: String(form.querySelector('[name="policy_id"]').value),
                    input: parsedInput,
                  };
                } else {
                  const formData = new FormData(form);
                  payload = Object.fromEntries(formData.entries());
                }
                const response = await fetch(endpoint, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', accept: 'application/json' },
                  body: JSON.stringify(payload),
                });

                const data = await response.json();
                if (!response.ok) {
                  resultTarget.innerHTML = renderResultCard(
                    form.dataset.playgroundForm === 'run' ? 'Run failed' : 'Chat failed',
                    '<p class="error">' + escapeHtml(data.error ?? 'Unknown error') + '</p>',
                  );
                  return;
                }

                if (form.dataset.playgroundForm === 'run') {
                  const runId = String(data.run_id ?? 'unknown');
                  resultTarget.innerHTML = renderResultCard(
                    'Run created',
                    '<p><code>' + escapeHtml(runId) + '</code></p>' +
                      '<p class="muted">project ' + escapeHtml(payload.project_id) + ' / policy ' + escapeHtml(payload.policy_id) + '</p>' +
                      '<p><a href="/status?runId=' + encodeURIComponent(runId) + '">Open run in status dashboard</a></p>',
                  );
                  return;
                }

                resultTarget.innerHTML = renderResultCard(
                  'Chat completed',
                  '<p><code>' + escapeHtml(String(data.threadId ?? 'unknown')) + '</code></p>' +
                    '<p class="muted">queue item ' + escapeHtml(String(data.queueItemId ?? 'unknown')) + '</p>' +
                    (data.finalMessage
                      ? '<pre style="white-space: pre-wrap; border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: rgba(255,255,255,0.72);">' + escapeHtml(String(data.finalMessage)) + '</pre>'
                      : '<p class="muted">No final output captured.</p>') +
                    (formatUsage(data.usage)
                      ? '<p class="muted">' + escapeHtml(formatUsage(data.usage)) + '</p>'
                      : '') +
                    (data.finalMessage
                      ? '<p><a href="/chat/threads/' + encodeURIComponent(String(data.threadId ?? 'unknown')) + '/output/final" target="_blank" rel="noreferrer">Open final output</a></p>'
                      : '') +
                    '<p><a href="/status">Open status dashboard</a></p>',
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : 'Playground request failed.';
                resultTarget.innerHTML = '<section class="card result-card error">' + message + '</section>';
              } finally {
                button.disabled = false;
              }
            }

            function syncUrlState() {
              const url = new URL(window.location.href);
              const activeSection = document.querySelector('[data-playground-section][open]')?.dataset.playgroundSection;
              const chatProject = document.getElementById('playground-chat-project');
              const runProject = document.getElementById('playground-run-project');
              const policySelect = document.querySelector('#playground-run-policy select[name="policy_id"]');
              const projectId = runProject?.value || chatProject?.value || '';

              if (projectId) url.searchParams.set('project_id', projectId);
              else url.searchParams.delete('project_id');

              if (policySelect instanceof HTMLSelectElement && !policySelect.disabled && policySelect.value) {
                url.searchParams.set('policy_id', policySelect.value);
              } else {
                url.searchParams.delete('policy_id');
              }

              if (activeSection) url.searchParams.set('section', activeSection);
              else url.searchParams.delete('section');

              window.history.replaceState({}, '', url);
            }

            function syncProjectSelects(projectId, source) {
              const chatProject = document.getElementById('playground-chat-project');
              const runProject = document.getElementById('playground-run-project');

              if (chatProject instanceof HTMLSelectElement && source !== 'chat' && chatProject.value !== projectId) {
                chatProject.value = projectId;
              }

              if (runProject instanceof HTMLSelectElement && source !== 'run' && runProject.value !== projectId) {
                runProject.value = projectId;
                runProject.dispatchEvent(new Event('change', { bubbles: true }));
                return;
              }

              syncUrlState();
            }

            function syncRunButtonState() {
              const runForm = document.querySelector('[data-playground-form="run"]');
              const button = runForm?.querySelector('button[type="submit"]');
              const projectSelect = document.getElementById('playground-run-project');
              const policySelect = document.querySelector('#playground-run-policy select[name="policy_id"]');
              if (!(button instanceof HTMLButtonElement)) return;
              const hasProject = projectSelect instanceof HTMLSelectElement && !projectSelect.disabled && projectSelect.value.length > 0;
              const hasPolicy = policySelect instanceof HTMLSelectElement && !policySelect.disabled && policySelect.value.length > 0;
              button.disabled = !(hasProject && hasPolicy);
            }

            function syncChatButtonState() {
              const chatForm = document.querySelector('[data-playground-form="chat"]');
              const button = chatForm?.querySelector('button[type="submit"]');
              const projectSelect = document.getElementById('playground-chat-project');
              if (!(button instanceof HTMLButtonElement)) return;
              button.disabled = !(projectSelect instanceof HTMLSelectElement && !projectSelect.disabled && projectSelect.value.length > 0);
            }

            document.addEventListener('change', (event) => {
              const target = event.target;
              if (target instanceof HTMLSelectElement && target.dataset.projectSelect === 'chat') {
                syncProjectSelects(target.value, 'chat');
                syncChatButtonState();
              }
              if (target instanceof HTMLSelectElement && target.dataset.projectSelect === 'run') {
                syncProjectSelects(target.value, 'run');
                syncRunButtonState();
              }
              if (target instanceof HTMLSelectElement && target.name === 'policy_id') {
                syncRunButtonState();
                syncUrlState();
              }
            });

            document.body.addEventListener('htmx:afterSwap', (event) => {
              if (event.target?.id === 'playground-run-policy') {
                syncRunButtonState();
                syncUrlState();
              }
            });

            for (const accordion of document.querySelectorAll('[data-playground-section]')) {
              accordion.addEventListener('toggle', () => {
                if (!accordion.open) return;
                for (const other of document.querySelectorAll('[data-playground-section]')) {
                  if (other !== accordion) other.open = false;
                }
                syncUrlState();
              });
            }

            for (const form of document.querySelectorAll('[data-playground-form="chat"]')) {
              form.addEventListener('submit', (event) => {
                event.preventDefault();
                submitPlaygroundForm(form, '/chat');
              });
            }

            for (const form of document.querySelectorAll('[data-playground-form="run"]')) {
              form.addEventListener('submit', (event) => {
                event.preventDefault();
                submitPlaygroundForm(form, '/runs');
              });
            }

            syncChatButtonState();
            syncRunButtonState();
            syncUrlState();
          </script>
        </body>
      </html>
    `;
  });

  app.get("/playground/partials/run-policy", { schema: { hide: true, querystring: PolicyQuerySchema } }, async (request, reply) => {
    const query = request.query as z.infer<typeof PolicyQuerySchema>;
    const projectId = query.project_id ?? null;
    const policies = projectId ? await listProjectPolicies(config, projectId) : [];
    const selectedPolicyId = policies.some((policy) => policy.policy_id === query.policy_id)
      ? (query.policy_id ?? null)
      : (policies[0]?.policy_id ?? null);
    reply.type("text/html; charset=utf-8");
    return renderPolicyField(projectId, policies, selectedPolicyId);
  });
}
