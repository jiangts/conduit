import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConduitConfig } from "../src/config";
import { createServer } from "../server";

interface TestProject {
  path: string;
  policies: Record<string, { yaml: string; files?: Record<string, string> }>;
  gitHead?: string;
}

const cleanupDirs: string[] = [];
const apps: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
  while (cleanupDirs.length > 0) {
    await rm(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

async function createProjectFixture(projects: Record<string, TestProject>) {
  const rootDir = await mkdtemp(join(tmpdir(), "conduit-projects-"));
  cleanupDirs.push(rootDir);

  const resolvedProjects: ConduitConfig["projects"] = {};
  for (const [projectId, project] of Object.entries(projects)) {
    const projectDir = join(rootDir, project.path);
    resolvedProjects[projectId] = { path: projectDir };
    await mkdir(join(projectDir, ".git"), { recursive: true });
    await writeFile(join(projectDir, ".git", "HEAD"), project.gitHead ?? "ref: refs/heads/main\n", "utf8");

    for (const [policyId, policy] of Object.entries(project.policies)) {
      const policyDir = join(projectDir, ".conduit", "policies", policyId);
      await mkdir(policyDir, { recursive: true });
      await writeFile(join(policyDir, "policy.yaml"), policy.yaml, "utf8");
      for (const [relativePath, content] of Object.entries(policy.files ?? {})) {
        const fullPath = join(policyDir, relativePath);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf8");
        if (relativePath.endsWith(".sh")) {
          await chmod(fullPath, 0o755);
        }
      }
    }
  }

  return {
    rootDir,
    config: {
      defaultRunner: "codex",
      stateDir: join(rootDir, "state"),
      projects: resolvedProjects,
      runners: {
        claude: { args: [] },
        codex: { args: [] },
        cursor: { args: [] },
        gemini: { args: [] },
      },
      server: {
        port: 8888,
        allowInit: false,
        debug: false,
        enableDocs: false,
        queue: {
          maxQueuedRuns: null,
          maxActiveRuns: null,
        },
        throttling: {
          enabled: false,
          windowMs: 60_000,
          maxRequests: 60,
          key: "ip",
        },
        requestControls: {
          cwd: "disabled",
          db: "disabled",
          args: "disabled",
        },
      },
    } satisfies ConduitConfig,
  };
}

async function createApp(config: ConduitConfig) {
  const app = await createServer(config);
  apps.push(app);
  return app;
}

describe("Conduit /projects routes", () => {
  it("lists configured projects and resolved project details", async () => {
    const fixture = await createProjectFixture({
      alpha: {
        path: "alpha",
        policies: {
          "fix_bug.v1": {
            yaml: `
policy_id: fix_bug.v1
task_id: fix_bug
runner:
  provider: codex
checks:
  - name: smoke
    command: npm test
retry:
  max_attempts: 2
            `.trim(),
          },
          "write_tests.v1": {
            yaml: `
policy_id: write_tests.v1
task_id: write_tests
retry:
  max_attempts: 1
            `.trim(),
          },
        },
        gitHead: "ref: refs/heads/trunk\n",
      },
      beta: {
        path: "beta",
        policies: {},
      },
    });
    const app = await createApp(fixture.config);

    const projectsResponse = await app.inject({
      method: "GET",
      url: "/projects",
    });
    expect(projectsResponse.statusCode).toBe(200);
    expect(projectsResponse.json()).toEqual([
      {
        project_id: "alpha",
        path: join(fixture.rootDir, "alpha"),
      },
      {
        project_id: "beta",
        path: join(fixture.rootDir, "beta"),
      },
    ]);

    const projectResponse = await app.inject({
      method: "GET",
      url: "/projects/alpha",
    });
    expect(projectResponse.statusCode).toBe(200);
    expect(projectResponse.json()).toEqual({
      project_id: "alpha",
      path: join(fixture.rootDir, "alpha"),
      default_branch: "trunk",
      policies: [
        {
          policy_id: "fix_bug.v1",
          task_id: "fix_bug",
          path: join(fixture.rootDir, "alpha", ".conduit", "policies", "fix_bug.v1"),
        },
        {
          policy_id: "write_tests.v1",
          task_id: "write_tests",
          path: join(fixture.rootDir, "alpha", ".conduit", "policies", "write_tests.v1"),
        },
      ],
    });
  });

  it("lists policies and resolves one policy", async () => {
    const fixture = await createProjectFixture({
      alpha: {
        path: "alpha",
        policies: {
          "fix_bug.v1": {
            yaml: `
policy_id: fix_bug.v1
task_id: fix_bug
runner:
  provider: codex
  model: gpt-5-codex
hooks:
  init:
    - ./init.sh
checks:
  - name: smoke
    command: npm test
    timeout_seconds: 300
    on_fail: fail
retry:
  max_attempts: 2
  timeout_seconds: 900
  escalation:
    - runner:
        provider: gemini
        model: 2.5-pro
            `.trim(),
            files: {
              "init.sh": "#!/usr/bin/env bash\nexit 0\n",
            },
          },
        },
      },
    });
    const app = await createApp(fixture.config);

    const policiesResponse = await app.inject({
      method: "GET",
      url: "/projects/alpha/policies",
    });
    expect(policiesResponse.statusCode).toBe(200);
    expect(policiesResponse.json()).toEqual([
      {
        policy_id: "fix_bug.v1",
        task_id: "fix_bug",
        path: join(fixture.rootDir, "alpha", ".conduit", "policies", "fix_bug.v1"),
      },
    ]);

    const policyResponse = await app.inject({
      method: "GET",
      url: "/projects/alpha/policies/fix_bug.v1",
    });
    expect(policyResponse.statusCode).toBe(200);
    expect(policyResponse.json()).toEqual({
      policy_id: "fix_bug.v1",
      task_id: "fix_bug",
      runner: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      hooks: {
        init: ["./init.sh"],
        before_attempt: [],
        after_attempt: [],
        on_success: [],
        on_failure: [],
      },
      checks: [
        {
          name: "smoke",
          command: "npm test",
          timeout_seconds: 300,
          on_fail: "fail",
        },
      ],
      retry: {
        max_attempts: 2,
        timeout_seconds: 900,
        escalation: [
          {
            provider: "gemini",
            model: "2.5-pro",
          },
        ],
      },
      policy_dir: join(fixture.rootDir, "alpha", ".conduit", "policies", "fix_bug.v1"),
    });
  });

  it("returns 404 for missing projects and policies", async () => {
    const fixture = await createProjectFixture({
      alpha: {
        path: "alpha",
        policies: {},
      },
    });
    const app = await createApp(fixture.config);

    const missingProject = await app.inject({
      method: "GET",
      url: "/projects/missing",
    });
    expect(missingProject.statusCode).toBe(404);
    expect(missingProject.json()).toEqual({ error: 'Project "missing" not found' });

    const missingPolicy = await app.inject({
      method: "GET",
      url: "/projects/alpha/policies/missing.v1",
    });
    expect(missingPolicy.statusCode).toBe(404);
    expect(missingPolicy.json()).toEqual({ error: 'Policy "missing.v1" not found for project "alpha"' });
  });

  it("skips dangling policy directories that do not contain policy.yaml", async () => {
    const fixture = await createProjectFixture({
      alpha: {
        path: "alpha",
        policies: {
          "fix_bug.v1": {
            yaml: `
policy_id: fix_bug.v1
task_id: fix_bug
retry:
  max_attempts: 1
            `.trim(),
          },
        },
      },
    });
    await mkdir(join(fixture.rootDir, "alpha", ".conduit", "policies", "dangling.v1"), { recursive: true });
    const app = await createApp(fixture.config);

    const policiesResponse = await app.inject({
      method: "GET",
      url: "/projects/alpha/policies",
    });

    expect(policiesResponse.statusCode).toBe(200);
    expect(policiesResponse.json()).toEqual([
      {
        policy_id: "fix_bug.v1",
        task_id: "fix_bug",
        path: join(fixture.rootDir, "alpha", ".conduit", "policies", "fix_bug.v1"),
      },
    ]);
  });
});
