# Conduit

Conduit is a local execution runtime for coding agents.

Any task you have at work is now an API call.

It provides headless CLI and HTTP control plane for running, routing, and orchestrating coding agents like Claude Code, Codex CLI, Cursor Agent, and Gemini CLI.

Think of it as API hooks for coding agents: a lightweight control plane that turns incoming work from scripts, services, CI, and other connectors into repeatable agent execution.

It gives you four core capabilities:

- Switch between multiple coding agents with one consistent CLI (`claude`, `codex`, `cursor`, `gemini`).
- Expose those agents as a local/private HTTP service so other systems can trigger runs and build automations.
- Run agents headlessly, without interactive babysitting or terminal session management.
- Provide a normalized execution layer that callers can compose into scripts, client commands, and higher-level workflows.

## Why Conduit

I built Conduit for three reasons:

- I want to 10x or 100x my agent usage.
- I got tired of babysitting Claude Code and Codex. The headless, non-interactive model is a feature, not a limitation.
- I want to automate my job by turning recurring work into API-triggered agent runs.

That leads to the core thesis:

- Any task you have at work is now an API call.
- Every place work enters your system can become a connector into Conduit.
- Fan-out and comparison can be layered on top by caller scripts or companion client commands.

In practice, this means:

- Route incoming work from scripts, CI, cron jobs, issue queues, webhooks, and internal tools into Conduit.
- Generate a first draft for tasks that would otherwise sit in a backlog or require manual agent prompting.
- Use the same runtime for direct CLI use, service-to-service automation, and higher-level integrations.

## Security Model (Important)

Conduit executes local agent commands with the same privileges as the OS user running it.

- Keep it private by default.
- Prefer binding to loopback (`127.0.0.1`) and exposing only through your private network controls.
- Current server routes are not authenticated by default.

Never expose Conduit directly to the public internet.
Do not expose this directly to the public internet unless you add strong auth and network controls.

## Requirements

- Node.js
- dependencies installed for this repo
- `tsx` available if you want to invoke the entry files directly
- Provider CLIs installed and authenticated for the agents you plan to use:
  - `claude`
  - `codex`
  - `cursor-agent`
  - `gemini`

## Quick Start (CLI)

From the `conduit/` directory:

```bash
tsx cli.ts chat "Implement pagination for this endpoint" --runner=codex/gpt-5
```

Ergonomic shorthand (local shell alias/function):

```bash
conduit chat "Implement pagination for this endpoint" --runner codex/gpt-5
```

Backward-compatible shorthand still works:

```bash
conduit "Implement pagination for this endpoint" --runner codex/gpt-5
```

`--runner` accepts either `provider` or `provider/model`.

Switch agents with the same command shape:

```bash
tsx cli.ts chat "Implement pagination for this endpoint" --runner=claude/sonnet-4
tsx cli.ts chat "Implement pagination for this endpoint" --runner=cursor
tsx cli.ts chat "Implement pagination for this endpoint" --runner=gemini
```

Pass provider-specific flags after `--`:

```bash
tsx cli.ts chat "Refactor this module" --runner=codex/gpt-5 -- --approval-mode on-request
```

Resume a provider session/thread:

```bash
tsx cli.ts chat "Continue from previous work" --runner=claude/sonnet-4 --resume="session-id"
```

Execution-mode commands target the HTTP server:

```bash
tsx cli.ts serve
```

Detached runtime management remains available:

```bash
tsx cli.ts runtime start
tsx cli.ts runtime status
tsx cli.ts runtime stop
tsx cli.ts projects list
tsx cli.ts runs create --project billing-service --policy fix_bug.default.v1 --input '{"issue":"invoice rounding"}'
tsx cli.ts runs watch <runId> --attempts
```

One-shot execution can run locally without the runtime:

```bash
tsx cli.ts runs create --project billing-service --policy fix_bug.default.v1 --input '{"issue":"invoice rounding"}' --wait
```

## Two Operating Modes

Conduit has two complementary modes:

- Chat Mode (`/chat/*`): interactive agent usage and thread control.
- Execution Mode (`/runs*`, `/projects*`): deterministic run automation triggered by services, scripts, or CI.

`/chat` is optimized for human-in-the-loop interactions.
`/runs` is optimized for repeatable automation and run lifecycle control.

If your goal is automation, `/runs` is the main product surface: connectors and integrations can turn incoming work into Conduit API calls, then consume artifacts, logs, and check outputs downstream.

## Run as a Service

This is the integration surface of the product. If work shows up somewhere in your stack, you can usually route it into Conduit with a thin connector or script and get back a first-pass result plus execution artifacts.

Start the HTTP server in the foreground:

```bash
tsx cli.ts serve
```

Or run the server entrypoint directly:

```bash
HOST=127.0.0.1 PORT=8888 tsx server.ts
```

By default:

- Health check: `GET /healthz`
- Status dashboard: `GET /status`
- Playground: `GET /playground`
- API docs: `GET /docs` (enabled by default)

Chat API:

- `POST /chat`
- `GET /chat/threads/:threadId`
- `POST /chat/threads/:threadId/cancel`
- `POST /chat/init` (optional)

Runs API:

- `POST /runs`
- `GET /runs/:runId`
- `GET /runs/:runId?include=attempts`
- `GET /runs/:runId/attempts/:attemptIndex/output/agent?stream=stdout|stderr`
- `GET /runs/:runId/attempts/:attemptIndex/output/checks/:checkName?stream=stdout|stderr`
- `POST /runs/:runId/cancel`

Execution runtime topology is machine-level by default:

- One Conduit server per machine/user.
- Project registry in user config maps `project_id -> repo_path`.
- Execution policies remain repo-local under `.conduit/policies/*`.
- Canonical run state and check outputs live under `~/.conduit/runs/`.

Identity boundary:

- `threadId` is Conduit's chat identity and is the ID exposed in `/chat/*` APIs.
- `sessionId` is runner/provider resume metadata used inside adapters (not a top-level public API ID).

## Chat API

Simple chat run (same contract as current one-shot `/run`, renamed):

```bash
curl -sS -X POST http://127.0.0.1:8888/chat \
  -H 'content-type: application/json' \
  -d '{
    "project_id": "billing-service",
    "prompt": "Add retries to this function",
    "external_ref": "ui-chat-123",
    "runner": {
      "provider": "codex",
      "model": "gpt-5-codex"
    }
  }'
```

Simple chat run with SSE (same contract as current `/run` SSE behavior, renamed):

```bash
curl -N -X POST http://127.0.0.1:8888/chat \
  -H 'accept: text/event-stream' \
  -H 'content-type: application/json' \
  -d '{
    "project_id": "billing-service",
    "prompt": "Generate tests for this file",
    "runner": {
      "provider": "claude"
    }
  }'
```

Chat thread status/cancel:

```bash
curl -sS "http://127.0.0.1:8888/chat/threads/<threadId>"
curl -sS -X POST "http://127.0.0.1:8888/chat/threads/<threadId>/cancel" \
  -H 'content-type: application/json' \
  -d '{"runner":{"provider":"codex"}}'
```

Chat endpoints:

- `POST /chat`
- `GET /chat/threads/:threadId`
- `POST /chat/threads/:threadId/cancel`
- `POST /chat/init` (optional)

`POST /chat` requires `project_id` and resolves execution from the configured project registry rather than the server process working directory.

## Runs API

Deterministic run example:

```bash
curl -sS -X POST http://127.0.0.1:8888/runs \
  -H 'content-type: application/json' \
  -d '{
    "project_id": "billing-service",
    "policy_id": "fix_bug.default.v1",
    "input": {
      "issue": "invoice rounding error"
    }
  }'
```

Execution policies are repo-local contracts under `.conduit/policies/`, one directory per `policy_id`.
Current schema shape:

```yaml
policy_id: fix_bug.default.v1
task_id: fix_bug
runner:
  provider: claude
  model: sonnet-4
checks:
  - name: unit_tests
    command: npm test
    on_fail: retry
  - name: lint
    command: npm run lint
    on_fail: retry
```

If `checks` is omitted or empty, a run succeeds once the agent attempt and lifecycle hooks complete successfully.

Implemented now:

- ✅ `/runs` attempts invoke the configured agent before checks run
- ✅ retryable check failures are fed back into the next attempt as structured retry context
- ✅ `retry.escalation` can switch later attempts to fallback runners/models
- ✅ per-attempt agent prompt/stdout/stderr/result artifacts are persisted under the run state dir
- ✅ `/status` provides an HTMX-powered operator dashboard for queue state, runs, attempts, and logs
- ✅ `/playground` provides lightweight operator forms for ad hoc chat and run submission
- ✅ `/projects*` discovery endpoints are available for configured projects and repo-local policies

Expanded run details expose attempt-level agent stdout/stderr output URLs alongside per-check stdout/stderr URLs.

Status dashboard endpoints:

- `GET /status`
- `GET /status/partials/summary`
- `GET /status/partials/chat`
- `GET /status/partials/runs`
- `GET /status/partials/runs/:runId`

Playground endpoints:

- `GET /playground`
- `GET /playground/partials/run-policy`
- `POST /playground/actions/chat`
- `POST /playground/actions/run`

```text
.conduit/policies/
  fix_bug.default.v1/
    policy.yaml
    init.sh
    before_attempt.sh
    after_attempt.sh
    on_success.sh
    on_failure.sh
```

This is similar to agent skills in that both are file-backed behavior packs.
Difference: Conduit policies are orchestrator-owned runtime contracts (setup, validation, retry/escalation, check outputs), not just agent prompting guidance.

Full policy schema and field reference:
- `plans/execution_policy_schema.md`

Run status:

```bash
curl -sS "http://127.0.0.1:8888/runs/<runId>"
tsx cli.ts runs get <runId>
```

Run status with attempts:

```bash
curl -sS "http://127.0.0.1:8888/runs/<runId>?include=attempts"
tsx cli.ts runs get <runId> --attempts
```

Check outputs can be read over HTTP today:

```bash
curl -sS "http://127.0.0.1:8888/runs/<runId>/attempts/<attemptIndex>/output/checks/<checkName>?stream=stdout"
curl -sS "http://127.0.0.1:8888/runs/<runId>/attempts/<attemptIndex>/output/agent?stream=stderr"
```

Run cancel:

```bash
curl -sS -X POST "http://127.0.0.1:8888/runs/<runId>/cancel"
tsx cli.ts runs cancel <runId>
```

Run create/watch via CLI:

```bash
tsx cli.ts runs create --project billing-service --policy fix_bug.default.v1 --input '{"issue":"invoice rounding"}'
tsx cli.ts runs create --project billing-service --policy fix_bug.default.v1 --input '{"issue":"invoice rounding"}' --wait
tsx cli.ts runs watch <runId> --attempts
```

Run endpoints:

- `POST /runs`
- `GET /runs/:runId`
- `GET /runs/:runId?include=attempts`
- `GET /runs/:runId/attempts/:attemptIndex/output/agent?stream=stdout|stderr`
- `GET /runs/:runId/attempts/:attemptIndex/output/checks/:checkName?stream=stdout|stderr`
- `POST /runs/:runId/cancel`

Available project/runtime discovery endpoints:

- `GET /projects`
- `GET /projects/:projectId`
- `GET /projects/:projectId/policies`
- `GET /projects/:projectId/policies/:policyId`

Planned runtime extensions:

- `POST /runs/:runId/checks` (optional external validator ingest)
- `POST /runs/:runId/steps` (optional external lifecycle ingest)
- `POST /projects/:projectId/policies/:policyId/runs` (convenience wrapper around `POST /runs` with fixed `project_id` and `policy_id`)

Project and extended runtime APIs are still described in:
- `plans/position_execution_v2.md`

## Compare Agents on the Same Task

Example loop for quick comparison:

```bash
for runner in claude codex cursor gemini; do
  echo "=== $runner ==="
  tsx cli.ts chat "Design a migration plan for this schema change" --runner="$runner"
done
```

This is the intended comparison pattern: a caller script or separate client command fans out work by invoking Conduit once per runner, then compares outputs externally.

This makes it easy to benchmark response quality, speed, and reliability across agents on identical prompts without embedding selection policy into Conduit itself.

For concurrent fan-out with minimal manual overhead, have the caller layer call the HTTP API in parallel:

```bash
printf '%s\n' claude codex cursor gemini | xargs -I{} -P4 \
  curl -sS -X POST http://127.0.0.1:8888/chat \
    -H 'content-type: application/json' \
    -d "{\"project_id\":\"billing-service\",\"prompt\":\"Implement this feature and include tests\",\"runner\":{\"provider\":\"{}\"}}"
```

This is the main orchestration benefit over direct agent usage: no per-agent directory switching, startup ceremony, or interactive session management.

If you want consensus behavior, implement it in the caller layer:

- define the runner set or runner configurations
- launch one Conduit run per configuration
- collect normalized outputs and check outputs
- score, judge, or manually choose a preferred result outside Conduit

The current design direction is documented in `plans/search_mode/consensus_mode.md`.

## Artifact Layout

Canonical default path:

```text
~/.conduit/runs/
  run_123/
    run.json
    logs.txt
    checks/
    attempts/
      attempt_1/
      attempt_2/
```

Artifacts are used for debugging, evaluation, and benchmarking across runners and profiles.

## Configuration

Conduit supports global and per-project config:

- Global defaults:
  - `~/.conduit/config.yaml`
  - `~/.conduit/config.yml`
- Project overrides:
  - `<project>/.conduit/config.yaml`
  - `<project>/.conduit/config.yml`
  - discovered by walking up from the current working directory to filesystem root

Precedence (highest to lowest):

1. CLI flags / request overrides (when enabled)
2. Project config
3. Global config
4. Built-in defaults

Example:

```yaml
conduit:
  defaultRunner: codex
  stateDir: ~/.conduit
  projects:
    billing-service:
      path: /repos/billing-service
    conduit:
      path: /repos/conduit
  runners:
    codex:
      args: ["--approval-mode", "on-request"]
    claude:
      args: ["--verbose"]
  server:
    port: 8888
    allowInit: false
    debug: true
    enableDocs: true
    queue:
      maxQueuedRuns: null
      maxActiveRuns: null
    throttling:
      enabled: false
      windowMs: 60000
      maxRequests: 60
      key: ip
    requestControls:
      cwd: disabled
      db: disabled
      args: disabled
```

## Notes

- Runtime state root defaults to `conduit.stateDir = ~/.conduit`.
- Runtime DB is derived as `<stateDir>/db.sqlite`.
- Run records and check outputs should live under `<stateDir>/runs/`.
- `requestControls` defaults to `disabled` for safer remote execution behavior.
- In `debug: false`, response payloads are redacted more aggressively.
