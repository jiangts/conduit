import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadGlobalConduitConfig,
  loadConduitConfig,
  parseConduitConfig,
  resolveEffectiveRunnerArgs,
  resolveStateDbPath,
} from "../src/config";

describe("conduit config", () => {
  it("parses defaults when config is empty", () => {
    const config = parseConduitConfig("");
    expect(config.defaultRunner).toBe("claude");
    expect(config.stateDir).toBe(join(process.env.HOME ?? "", ".conduit"));
    expect(resolveStateDbPath(config)).toBe(join(process.env.HOME ?? "", ".conduit", "db.sqlite"));
    expect(config.projects).toEqual({});
    expect(config.runners.claude.args).toEqual([]);
    expect(config.runners.codex.args).toEqual([]);
    expect(config.runners.cursor.args).toEqual([]);
    expect(config.runners.gemini.args).toEqual([]);
    expect(config.server.port).toBe(8888);
    expect(config.server.allowInit).toBe(false);
    expect(config.server.debug).toBe(true);
    expect(config.server.enableDocs).toBe(true);
    expect(config.server.queue.maxQueuedRuns).toBeNull();
    expect(config.server.queue.maxActiveRuns).toBeNull();
    expect(config.server.throttling.enabled).toBe(false);
    expect(config.server.throttling.windowMs).toBe(60000);
    expect(config.server.throttling.maxRequests).toBe(60);
    expect(config.server.throttling.key).toBe("ip");
    expect(config.server.requestControls.cwd).toBe("disabled");
    expect(config.server.requestControls.db).toBe("disabled");
    expect(config.server.requestControls.args).toBe("disabled");
  });

  it("parses default runner and per-runner args", () => {
    const config = parseConduitConfig(`
conduit:
  defaultRunner: codex
  stateDir: /tmp/custom-conduit
  projects:
    billing-service:
      path: /repos/billing-service
  runners:
    codex:
      args: ["--approval-mode", "on-request"]
    claude:
      args: ["--verbose"]
`);

    expect(config.defaultRunner).toBe("codex");
    expect(config.stateDir).toBe("/tmp/custom-conduit");
    expect(resolveStateDbPath(config)).toBe("/tmp/custom-conduit/db.sqlite");
    expect(config.projects).toEqual({
      "billing-service": {
        path: "/repos/billing-service",
      },
    });
    expect(config.runners.codex.args).toEqual(["--approval-mode", "on-request"]);
    expect(config.runners.claude.args).toEqual(["--verbose"]);
    expect(config.runners.cursor.args).toEqual([]);
    expect(config.runners.gemini.args).toEqual([]);
    expect(config.server.allowInit).toBe(false);
  });

  it("parses server controls", () => {
    const config = parseConduitConfig(`
conduit:
  server:
    port: 9012
    allowInit: true
    debug: false
    enableDocs: false
    queue:
      maxQueuedRuns: 20
      maxActiveRuns: 2
    throttling:
      enabled: true
      windowMs: 30000
      maxRequests: 10
      key: global
    requestControls:
      cwd: read_write
      db: read_only
      args: read_write
`);

    expect(config.server.port).toBe(9012);
    expect(config.server.allowInit).toBe(true);
    expect(config.server.debug).toBe(false);
    expect(config.server.enableDocs).toBe(false);
    expect(config.server.queue.maxQueuedRuns).toBe(20);
    expect(config.server.queue.maxActiveRuns).toBe(2);
    expect(config.server.throttling.enabled).toBe(true);
    expect(config.server.throttling.windowMs).toBe(30000);
    expect(config.server.throttling.maxRequests).toBe(10);
    expect(config.server.throttling.key).toBe("global");
    expect(config.server.requestControls.cwd).toBe("read_write");
    expect(config.server.requestControls.db).toBe("read_only");
    expect(config.server.requestControls.args).toBe("read_write");
  });

  it("rejects unknown runner keys", () => {
    expect(() =>
      parseConduitConfig(`
conduit:
  runners:
    unknown:
      args: []
`),
    ).toThrow(/must be one of: claude, codex, cursor, gemini/);
  });

  it("rejects unknown project keys", () => {
    expect(() =>
      parseConduitConfig(`
conduit:
  projects:
    billing-service:
      path: /repos/billing-service
      branch: main
`),
    ).toThrow(/branch/);
  });

  it("rejects invalid server request control mode", () => {
    expect(() =>
      parseConduitConfig(`
conduit:
  server:
    requestControls:
      cwd: writable
`),
    ).toThrow(/Invalid option/);
  });

  it("rejects invalid server port", () => {
    expect(() =>
      parseConduitConfig(`
conduit:
  server:
    port: 70000
`),
    ).toThrow(/Too big/);
  });

  it("falls back to defaults when config file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conduit-config-"));
    const missingPath = join(dir, "missing.yaml");
    const config = await loadConduitConfig(missingPath);

    expect(config.defaultRunner).toBe("claude");
    expect(config.stateDir).toBe(join(homeFromEnv(), ".conduit"));
    expect(resolveStateDbPath(config)).toBe(join(homeFromEnv(), ".conduit", "db.sqlite"));
    expect(config.runners.claude.args).toEqual([]);
  });

  it("loads config.yml when config.yaml is absent", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "conduit-home-"));
    const conduitDir = join(homeDir, ".conduit");
    await mkdir(conduitDir, { recursive: true });
    await writeFile(
      join(conduitDir, "config.yml"),
      `
conduit:
  defaultRunner: codex
`,
      "utf8",
    );

    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const config = await loadGlobalConduitConfig();
      expect(config.defaultRunner).toBe("codex");
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it("overrides global config with nearest project config", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "conduit-home-"));
    const globalConduitDir = join(homeDir, ".conduit");
    await mkdir(globalConduitDir, { recursive: true });
    await writeFile(
      join(globalConduitDir, "config.yaml"),
      `
conduit:
  defaultRunner: claude
  stateDir: /tmp/global-conduit
  projects:
    billing-service:
      path: /repos/billing-service
  server:
    port: 9010
  runners:
    codex:
      args: ["--approval-mode", "never"]
`,
      "utf8",
    );

    const projectRoot = await mkdtemp(join(tmpdir(), "conduit-project-"));
    const projectConduitDir = join(projectRoot, ".conduit");
    await mkdir(projectConduitDir, { recursive: true });
    await writeFile(
      join(projectConduitDir, "config.yml"),
      `
conduit:
  defaultRunner: codex
  stateDir: .project-conduit
  project:
    id: worker-service
  runners:
    codex:
      args: ["--approval-mode", "on-request"]
`,
      "utf8",
    );
    const nestedProjectDir = join(projectRoot, "services", "api");
    await mkdir(nestedProjectDir, { recursive: true });

    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();
    process.env.HOME = homeDir;
    process.chdir(nestedProjectDir);
    try {
      const config = await loadConduitConfig();
      expect(config.defaultRunner).toBe("codex");
      expect(config.stateDir).toBe(".project-conduit");
      expect(resolveStateDbPath(config)).toBe(".project-conduit/db.sqlite");
      expect(config.projects["billing-service"]).toEqual({
        path: "/repos/billing-service",
      });
      expect(config.projects["worker-service"]?.path.endsWith(basename(projectRoot))).toBe(true);
      expect(config.runners.codex.args).toEqual(["--approval-mode", "on-request"]);
      // Preserved from global layer because project layer did not override it.
      expect(config.server.port).toBe(9010);
    } finally {
      process.chdir(previousCwd);
      process.env.HOME = previousHome;
    }
  });

  it("fails fast with actionable error when YAML is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conduit-config-"));
    const configPath = join(dir, "config.yaml");
    await writeFile(configPath, "conduit: [", "utf8");

    await expect(loadConduitConfig(configPath)).rejects.toThrow(
      new RegExp(`Invalid config at ${escapeRegExp(configPath)}:`),
    );
  });

  it('rejects project-local "conduit.projects" in favor of "conduit.project.id"', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "conduit-home-"));
    const globalConduitDir = join(homeDir, ".conduit");
    await mkdir(globalConduitDir, { recursive: true });
    await writeFile(join(globalConduitDir, "config.yaml"), "conduit:\n  projects: {}\n", "utf8");

    const projectRoot = await mkdtemp(join(tmpdir(), "conduit-project-"));
    const projectConduitDir = join(projectRoot, ".conduit");
    await mkdir(projectConduitDir, { recursive: true });
    await writeFile(
      join(projectConduitDir, "config.yaml"),
      `
conduit:
  projects:
    bad:
      path: /tmp/bad
`,
      "utf8",
    );

    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();
    process.env.HOME = homeDir;
    process.chdir(projectRoot);
    try {
      await expect(loadConduitConfig()).rejects.toThrow(/conduit\.projects.*conduit\.project\.id/i);
    } finally {
      process.chdir(previousCwd);
      process.env.HOME = previousHome;
    }
  });

  it("replaces configured args with passthrough args when provided", () => {
    const config = parseConduitConfig(`
conduit:
  runners:
    codex:
      args: ["--approval-mode", "on-request"]
`);

    expect(resolveEffectiveRunnerArgs(config, "codex", ["--foo", "bar"])).toEqual(["--foo", "bar"]);
    expect(resolveEffectiveRunnerArgs(config, "codex", [])).toEqual(["--approval-mode", "on-request"]);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function homeFromEnv(): string {
  return process.env.HOME ?? "";
}
