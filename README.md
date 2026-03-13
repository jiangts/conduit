# Conduit

Conduit turns coding agents into compute infrastructure.

It exposes coding agents (Claude Code, Codex, Cursor, Gemini) through a headless API so you can run dozens of agent tasks in parallel without juggling terminal windows.

Trigger agent work from software integrations, scripts, and internal tools while running your favorite coding agent(s) behind one consistent interface.

Conduit moves you from babysitting agents to scheduling them.

## Typical Use Cases

Conduit is useful when you want to:

- run many coding agents in parallel
- automate tasks by triggering agent work programmatically
- run multiple agents on the same task to benchmark cost, speed, and quality (fanout + consensus)

## Why Conduit

I built Conduit for three reasons:
- I want to 10x my effective token usage. See [our thesis](#our-thesis).
- I got tired of babysitting Claude Code and Codex.
- I want to automate recurring tasks by turning them into agent runs.

```text
Scripts / CI / Services
          |
          v
     Conduit Runtime
          |
   +------+------+------+
   |      |      |      |
 Claude  Codex Cursor Gemini
```

## Quick Start

Install Conduit globally:

```bash
npm install -g conduit
```

Prerequisites:

- Node.js
- Provider CLIs installed and authenticated for the agents you plan to use:
  - `claude-code`
  - `codex`
  - `cursor-agent`
  - `gemini`

Run a single task from the CLI:

```bash
conduit chat "Implement pagination for this endpoint" --runner codex/gpt-5
```

Run the same kind of task through the API:

```bash
conduit serve
curl -sS -X POST http://127.0.0.1:8888/chat \
  -H 'content-type: application/json' \
  -d '{
    "project_id": "billing-service",
    "prompt": "Implement pagination for this endpoint",
    "runner": {
      "provider": "codex",
      "model": "gpt-5"
    }
  }'
```

Fan out across multiple agents in parallel:

```bash
for runner in claude codex cursor gemini; do
  conduit chat "Write tests for this file" --runner "$runner" &
done
wait
```

Pass provider-specific flags after `--`:

```bash
conduit chat "Refactor this module" --runner codex/gpt-5 -- --approval-mode on-request
```

Resume a provider session or thread:

```bash
conduit chat "Continue from previous work" --runner claude/sonnet-4 --resume "session-id"
```

## Two Operating Modes

Conduit has two complementary lanes:

- `chat`: headless agent usage and thread control for direct prompting and ad hoc work.
- `runs`: execution mode for automation, checks, retries, and repeatable run control.

If `chat` is the direct-control lane, `runs` is basically a structured, more powerful version of [Ralph loop](https://claude.com/plugins/ralph-loop): agent-driven execution with explicit policies, checks, retries, and repeatable run control instead of just looping until the agent emits a `DONE` sentinel.

### Execution Policies

Policies are Conduit's file-backed behavior packs for execution mode.

They are similar to agent skills in that they live on disk and package reusable behavior. The difference is that Conduit policies are orchestrator-owned runtime contracts: setup, checks, retries, escalation, and success or failure hooks.

Example layout:

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

Minimal example:

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

## Run as a Service

Running Conduit as a local service is the main integration surface. If work already enters your stack through scripts, CI, issue queues, cron jobs, or internal tools, you can route that work into Conduit and get back agent output through a stable local API.

Start the server:

```bash
conduit serve
```

Once running, the main surfaces are:

- `POST /chat` for headless chat-style runs
- `POST /runs` for structured execution-mode runs
- `GET /healthz` for health checks
- `GET /status` for the operator dashboard
- `GET /docs` for API docs

Built-in docs and operator surfaces:

- visit `http://127.0.0.1:8888/docs` for the OpenAPI reference
- visit `http://127.0.0.1:8888/status` for the operator dashboard
- visit `http://127.0.0.1:8888/playground` for lightweight manual testing

Chat-mode API example:

```bash
curl -sS -X POST http://127.0.0.1:8888/chat \
  -H 'content-type: application/json' \
  -d '{
    "project_id": "billing-service",
    "prompt": "Add retries to this function",
    "runner": {
      "provider": "codex",
      "model": "gpt-5"
    }
  }'
```

Execution-mode API example:

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

Execution runtime topology is machine-level by default:

- one Conduit server per machine or user
- project registry in user config maps `project_id` to repo path
- policies stay repo-local under `.conduit/policies/`

## Why Not Just Use Agent CLIs Directly?

Direct agent CLIs are great for interactive coding. Conduit is for when you want those same agents to behave like programmable workers.

| Tool | Best for |
| --- | --- |
| Claude Code / Codex CLI / Cursor Agent / Gemini CLI | Interactive coding in a terminal |
| Conduit | Automated, parallel, API-driven agent execution |

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

## Compare Agents on the Same Task

Conduit is especially useful when you want to benchmark the same work across multiple agents without manually juggling terminals, sessions, or repo state.

Simple sequential comparison:

```bash
for runner in claude codex cursor gemini; do
  echo "=== $runner ==="
  conduit chat "Design a migration plan for this schema change" --runner "$runner"
done
```

Concurrent fan-out via the API:

```bash
printf '%s\n' claude codex cursor gemini | xargs -I{} -P4 \
  curl -sS -X POST http://127.0.0.1:8888/chat \
    -H 'content-type: application/json' \
    -d "{\"project_id\":\"billing-service\",\"prompt\":\"Implement this feature and include tests\",\"runner\":{\"provider\":\"{}\"}}"
```

## Security Model

Conduit executes local agent commands with the same privileges as the OS user running it.

- Keep it private by default.
- Prefer binding to loopback (`127.0.0.1`) and exposing only through your private network controls.
- Current server routes are not authenticated by default.

Never expose Conduit directly to the public internet.
Do not expose this directly to the public internet unless you add strong auth and network controls.

## Our Thesis

Most people aren't spending nearly enough tokens!

When given the right plan and context, agents do most work an order of magnitude faster and cheaper than humans.
Given this shift, the question is how to 1) maximize existing token usage and 2) unlock more valuable token usage.

My rough heuristic: if you can create a skill to repeatedly get ~75% quality on a task, you should **always** use the agent first. Best case, quality is very high and you eliminate that class of tasks. Worst case, you have some slop but also useful insight (a valuable first draft).
