import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { AgentKind } from "../types/agent-types";

const RUNNER_KINDS: AgentKind[] = ["claude", "codex", "cursor", "gemini"];
const DEFAULT_RUNNER: AgentKind = "claude";
const REQUEST_CONTROL_MODES = ["disabled", "read_only", "read_write"] as const;
const CONFIG_FILENAMES = ["config.yaml", "config.yml"] as const;

export type RequestControlMode = (typeof REQUEST_CONTROL_MODES)[number];

export interface ConduitServerRequestControls {
  cwd: RequestControlMode;
  db: RequestControlMode;
  args: RequestControlMode;
}

export interface ConduitServerConfig {
  port: number;
  allowInit: boolean;
  debug: boolean;
  enableDocs: boolean;
  queue: {
    maxQueuedRuns: number | null;
    maxActiveRuns: number | null;
  };
  throttling: {
    enabled: boolean;
    windowMs: number;
    maxRequests: number;
    key: "ip" | "global";
  };
  requestControls: ConduitServerRequestControls;
}

export interface ConduitProjectConfig {
  path: string;
}

export interface ConduitConfig {
  defaultRunner: AgentKind;
  stateDir: string;
  projects: Record<string, ConduitProjectConfig>;
  runners: Record<AgentKind, { args: string[] }>;
  server: ConduitServerConfig;
}

const RunnerKindSchema = z.enum(RUNNER_KINDS);
const RunnerArgsSchema = z.array(z.string());
const RequestControlModeSchema = z.enum(REQUEST_CONTROL_MODES);
const RunnerConfigSchema = z
  .object({
    args: RunnerArgsSchema.optional(),
  })
  .strict();
const LocalProjectSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();
const ConduitProjectSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();
const ConduitServerRequestControlsSchema = z
  .object({
    cwd: RequestControlModeSchema.optional(),
    db: RequestControlModeSchema.optional(),
    args: RequestControlModeSchema.optional(),
  })
  .strict();
const ConduitServerQueueSchema = z
  .object({
    maxQueuedRuns: z.number().int().min(1).nullable().optional(),
    maxActiveRuns: z.number().int().min(1).nullable().optional(),
  })
  .strict();
const ConduitServerThrottlingSchema = z
  .object({
    enabled: z.boolean().optional(),
    windowMs: z.number().int().min(1).optional(),
    maxRequests: z.number().int().min(1).optional(),
    key: z.enum(["ip", "global"]).optional(),
  })
  .strict();
const ConduitServerSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
    allowInit: z.boolean().optional(),
    debug: z.boolean().optional(),
    enableDocs: z.boolean().optional(),
    queue: ConduitServerQueueSchema.optional(),
    throttling: ConduitServerThrottlingSchema.optional(),
    requestControls: ConduitServerRequestControlsSchema.optional(),
  })
  .strict();
const ConduitSchema = z
  .object({
    defaultRunner: RunnerKindSchema.optional(),
    stateDir: z.string().min(1).optional(),
    project: LocalProjectSchema.optional(),
    projects: z.record(z.string(), ConduitProjectSchema).optional(),
    runners: z.record(z.string(), RunnerConfigSchema).optional(),
    server: ConduitServerSchema.optional(),
  })
  .strict();
const RootSchema = z
  .object({
    conduit: ConduitSchema.optional(),
  })
  .passthrough();

function getDefaultConfig(): ConduitConfig {
  return {
    defaultRunner: DEFAULT_RUNNER,
    stateDir: join(homedir(), ".conduit"),
    projects: {},
    runners: {
      claude: { args: [] },
      codex: { args: [] },
      cursor: { args: [] },
      gemini: { args: [] },
    },
    server: {
      port: 8888,
      allowInit: false,
      debug: true,
      enableDocs: true,
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
  };
}

function cloneConduitConfig(config: ConduitConfig): ConduitConfig {
  return {
    defaultRunner: config.defaultRunner,
    stateDir: config.stateDir,
    projects: Object.fromEntries(
      Object.entries(config.projects).map(([projectId, project]) => [
        projectId,
        {
          path: project.path,
        },
      ]),
    ),
    runners: {
      claude: { args: [...config.runners.claude.args] },
      codex: { args: [...config.runners.codex.args] },
      cursor: { args: [...config.runners.cursor.args] },
      gemini: { args: [...config.runners.gemini.args] },
    },
    server: {
      port: config.server.port,
      allowInit: config.server.allowInit,
      debug: config.server.debug,
      enableDocs: config.server.enableDocs,
      queue: {
        maxQueuedRuns: config.server.queue.maxQueuedRuns,
        maxActiveRuns: config.server.queue.maxActiveRuns,
      },
      throttling: {
        enabled: config.server.throttling.enabled,
        windowMs: config.server.throttling.windowMs,
        maxRequests: config.server.throttling.maxRequests,
        key: config.server.throttling.key,
      },
      requestControls: {
        cwd: config.server.requestControls.cwd,
        db: config.server.requestControls.db,
        args: config.server.requestControls.args,
      },
    },
  };
}

export function resolveConduitConfigPaths(): string[] {
  const baseDir = join(homedir(), ".conduit");
  return CONFIG_FILENAMES.map((name) => join(baseDir, name));
}

export function resolveProjectConfigPaths(startDir: string = process.cwd()): string[] {
  const resolvedStart = resolve(startDir);
  const paths: string[] = [];
  let current = resolvedStart;

  while (true) {
    for (const name of CONFIG_FILENAMES) {
      paths.push(join(current, ".conduit", name));
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return paths;
}

export function parseConduitConfig(rawYaml: string): ConduitConfig {
  const parsed = parseYaml(rawYaml) as unknown;
  return parseGlobalConduitConfigDocument(parsed);
}

export function parseGlobalConduitConfigDocument(document: unknown, baseConfig?: ConduitConfig): ConduitConfig {
  const defaults = cloneConduitConfig(baseConfig ?? getDefaultConfig());

  if (document === null || document === undefined) {
    return defaults;
  }

  const root = RootSchema.parse(document);
  if (!root.conduit) return defaults;

  const projects = cloneConduitConfig(defaults).projects;
  const configuredProjects = root.conduit.projects ?? {};
  for (const [projectId, projectConfig] of Object.entries(configuredProjects)) {
    projects[projectId] = {
      path: projectConfig.path,
    };
  }

  const runners = cloneConduitConfig(defaults).runners;
  const configuredRunners = root.conduit.runners ?? {};
  for (const [runnerName, runnerConfig] of Object.entries(configuredRunners)) {
    const parsedRunnerKind = RunnerKindSchema.safeParse(runnerName);
    if (!parsedRunnerKind.success) {
      throw new Error(`"conduit.runners.${runnerName}" must be one of: ${RUNNER_KINDS.join(", ")}`);
    }

    runners[parsedRunnerKind.data] = { args: runnerConfig.args ? [...runnerConfig.args] : [] };
  }

  const parsedDefaultRunner = root.conduit.defaultRunner ?? defaults.defaultRunner;
  const parsedStateDir = root.conduit.stateDir ?? defaults.stateDir;
  const parsedServerConfig = root.conduit.server;

  return {
    defaultRunner: parsedDefaultRunner,
    stateDir: parsedStateDir,
    projects,
    runners,
    server: {
      port: parsedServerConfig?.port ?? defaults.server.port,
      allowInit: parsedServerConfig?.allowInit ?? defaults.server.allowInit,
      debug: parsedServerConfig?.debug ?? defaults.server.debug,
      enableDocs: parsedServerConfig?.enableDocs ?? defaults.server.enableDocs,
      queue: {
        maxQueuedRuns: parsedServerConfig?.queue?.maxQueuedRuns ?? defaults.server.queue.maxQueuedRuns,
        maxActiveRuns: parsedServerConfig?.queue?.maxActiveRuns ?? defaults.server.queue.maxActiveRuns,
      },
      throttling: {
        enabled: parsedServerConfig?.throttling?.enabled ?? defaults.server.throttling.enabled,
        windowMs: parsedServerConfig?.throttling?.windowMs ?? defaults.server.throttling.windowMs,
        maxRequests: parsedServerConfig?.throttling?.maxRequests ?? defaults.server.throttling.maxRequests,
        key: parsedServerConfig?.throttling?.key ?? defaults.server.throttling.key,
      },
      requestControls: {
        cwd: parsedServerConfig?.requestControls?.cwd ?? defaults.server.requestControls.cwd,
        db: parsedServerConfig?.requestControls?.db ?? defaults.server.requestControls.db,
        args: parsedServerConfig?.requestControls?.args ?? defaults.server.requestControls.args,
      },
    },
  };
}

export function applyProjectConduitConfigDocument(
  document: unknown,
  baseConfig: ConduitConfig,
  projectPath: string,
): ConduitConfig {
  const defaults = cloneConduitConfig(baseConfig);

  if (document === null || document === undefined) {
    return defaults;
  }

  const root = RootSchema.parse(document);
  if (!root.conduit) return defaults;

  if (root.conduit.projects !== undefined) {
    throw new Error('Project-local config must not define "conduit.projects"; use "conduit.project.id" instead');
  }

  const runners = cloneConduitConfig(defaults).runners;
  const configuredRunners = root.conduit.runners ?? {};
  for (const [runnerName, runnerConfig] of Object.entries(configuredRunners)) {
    const parsedRunnerKind = RunnerKindSchema.safeParse(runnerName);
    if (!parsedRunnerKind.success) {
      throw new Error(`"conduit.runners.${runnerName}" must be one of: ${RUNNER_KINDS.join(", ")}`);
    }

    runners[parsedRunnerKind.data] = { args: runnerConfig.args ? [...runnerConfig.args] : [] };
  }

  const projects = cloneConduitConfig(defaults).projects;
  const localProjectId = root.conduit.project?.id?.trim();
  if (localProjectId) {
    projects[localProjectId] = {
      path: projectPath,
    };
  }

  const parsedServerConfig = root.conduit.server;

  return {
    defaultRunner: root.conduit.defaultRunner ?? defaults.defaultRunner,
    stateDir: root.conduit.stateDir ?? defaults.stateDir,
    projects,
    runners,
    server: {
      port: parsedServerConfig?.port ?? defaults.server.port,
      allowInit: parsedServerConfig?.allowInit ?? defaults.server.allowInit,
      debug: parsedServerConfig?.debug ?? defaults.server.debug,
      enableDocs: parsedServerConfig?.enableDocs ?? defaults.server.enableDocs,
      queue: {
        maxQueuedRuns: parsedServerConfig?.queue?.maxQueuedRuns ?? defaults.server.queue.maxQueuedRuns,
        maxActiveRuns: parsedServerConfig?.queue?.maxActiveRuns ?? defaults.server.queue.maxActiveRuns,
      },
      throttling: {
        enabled: parsedServerConfig?.throttling?.enabled ?? defaults.server.throttling.enabled,
        windowMs: parsedServerConfig?.throttling?.windowMs ?? defaults.server.throttling.windowMs,
        maxRequests: parsedServerConfig?.throttling?.maxRequests ?? defaults.server.throttling.maxRequests,
        key: parsedServerConfig?.throttling?.key ?? defaults.server.throttling.key,
      },
      requestControls: {
        cwd: parsedServerConfig?.requestControls?.cwd ?? defaults.server.requestControls.cwd,
        db: parsedServerConfig?.requestControls?.db ?? defaults.server.requestControls.db,
        args: parsedServerConfig?.requestControls?.args ?? defaults.server.requestControls.args,
      },
    },
  };
}

async function loadLayer(paths: string[]): Promise<{ document: unknown; path: string } | undefined> {
  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf8");
      return {
        document: parseYaml(raw) as unknown,
        path,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid config at ${path}: ${message}`);
    }
  }
  return undefined;
}

export async function loadGlobalConduitConfig(configPath?: string): Promise<ConduitConfig> {
  if (configPath) {
    const doc = await loadLayer([configPath]);
    return parseGlobalConduitConfigDocument(doc?.document, getDefaultConfig());
  }

  const globalDoc = await loadLayer(resolveConduitConfigPaths());
  return parseGlobalConduitConfigDocument(globalDoc?.document, getDefaultConfig());
}

export async function loadConduitConfig(configPath?: string): Promise<ConduitConfig> {

  if (configPath) {
    const doc = await loadLayer([configPath]);
    return parseGlobalConduitConfigDocument(doc?.document, getDefaultConfig());
  }

  let config = await loadGlobalConduitConfig();
  const projectDoc = await loadLayer(resolveProjectConfigPaths());
  if (projectDoc) {
    config = applyProjectConduitConfigDocument(projectDoc.document, config, dirname(dirname(projectDoc.path)));
  }

  return config;
}

export function resolveStateDbPath(config: ConduitConfig): string {
  return join(config.stateDir, "db.sqlite");
}

export function resolveEffectiveRunnerArgs(config: ConduitConfig, runner: AgentKind, passthroughArgs: string[]): string[] {
  if (passthroughArgs.length > 0) return [...passthroughArgs];
  return [...config.runners[runner].args];
}
