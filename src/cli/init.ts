import { access, chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { checkbox, input, select } from "@inquirer/prompts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Argv } from "yargs";

import type { ConduitConfig } from "../config";
import { parseGlobalConduitConfigDocument } from "../config/conduit";
import { runInstallCommand } from "./install";
import { parseRunnerRef } from "./runner-ref";

interface OutputWriter {
  write(chunk: string): unknown;
}

export interface InitDeps {
  stdout: OutputWriter;
  stderr: OutputWriter;
  config: Pick<ConduitConfig, "stateDir">;
  cwd?: () => string;
  interactive?: boolean;
  promptSelections?: (input: PromptContext) => Promise<PromptSelections>;
}

interface PresetDocument {
  defaults?: {
    runner_component?: unknown;
    before_attempt_hook_components?: unknown;
    check_components?: unknown;
    optional_hook_components?: unknown;
  };
  available?: {
    runner_components?: unknown;
    before_attempt_hook_components?: unknown;
    check_components?: unknown;
    optional_hook_components?: unknown;
  };
}

interface RunnerComponentDocument {
  runner?: {
    provider?: unknown;
    model?: unknown;
  };
}

interface HookComponentDocument {
  component?: {
    lifecycle?: unknown;
  };
  hook?: {
    command?: unknown;
  };
}

interface CheckComponentDocument {
  checks?: unknown;
}

interface PolicyCheckInput {
  name: string;
  command: string;
  timeout_seconds: number | null;
  on_fail: "retry" | "fail" | "ignore";
}

interface PromptChoice {
  id: string;
  label: string;
}

interface PromptContext {
  presets: PromptChoice[];
  defaultPreset: string;
  runnerComponents: PromptChoice[];
  defaultRunnerComponent: string;
  beforeAttemptHookComponents: PromptChoice[];
  defaultBeforeAttemptHookComponents: string[];
  checkComponents: PromptChoice[];
  defaultCheckComponents: string[];
  optionalHookComponents: PromptChoice[];
  defaultOptionalHookComponents: string[];
  suggestedProjectId: string;
}

interface PromptSelections {
  preset: string;
  runnerComponent: string;
  beforeAttemptHookComponents: string[];
  checkComponents: string[];
  optionalHookComponents: string[];
  projectId: string;
}

interface InitResult {
  project_id: string;
  project_path: string;
  policy_id: string;
  local_config_path: string;
  global_config_path: string;
  created_local_config: boolean;
  created_policy: boolean;
  installed_global_state: {
    created_state_dir: boolean;
    created_config: boolean;
  };
}

function writeJson(writer: OutputWriter, value: unknown): void {
  writer.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function resolveProjectRoot(startDir: string): string {
  return resolve(startDir);
}

async function isGitProject(projectPath: string): Promise<boolean> {
  return pathExists(join(projectPath, ".git"));
}

function sanitizeProjectId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "project";
}

async function readYamlDocument(path: string): Promise<unknown> {
  return parseYaml(await readFile(path, "utf8")) as unknown;
}

function asStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`Invalid ${label} in bundled preset`);
  }
  return value;
}

async function loadPreset(stateDir: string, presetId: string): Promise<PresetDocument> {
  const path = join(stateDir, "presets", presetId, "preset.yaml");
  return (await readYamlDocument(path)) as PresetDocument;
}

async function listComponentIds(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function listPresetIds(stateDir: string): Promise<string[]> {
  return listComponentIds(join(stateDir, "presets"));
}

async function loadRunnerComponent(stateDir: string, componentId: string): Promise<{ provider: string; model: string | null }> {
  const path = join(stateDir, "components", "runners", componentId, "component.yaml");
  const document = (await readYamlDocument(path)) as RunnerComponentDocument;
  const provider = document.runner?.provider;
  const model = document.runner?.model;
  if (typeof provider !== "string" || provider.length === 0) {
    throw new Error(`Runner component "${componentId}" is missing runner.provider`);
  }
  if (model !== undefined && model !== null && typeof model !== "string") {
    throw new Error(`Runner component "${componentId}" has invalid runner.model`);
  }
  return {
    provider,
    model: typeof model === "string" ? model : null,
  };
}

async function loadHookComponent(
  stateDir: string,
  componentId: string,
): Promise<{ lifecycle: "init" | "before_attempt" | "after_attempt" | "on_success" | "on_failure"; command: string; sourceDir: string }> {
  const sourceDir = join(stateDir, "components", "hooks", componentId);
  const document = (await readYamlDocument(join(sourceDir, "component.yaml"))) as HookComponentDocument;
  const lifecycle = document.component?.lifecycle;
  const command = document.hook?.command;
  if (
    lifecycle !== "init" &&
    lifecycle !== "before_attempt" &&
    lifecycle !== "after_attempt" &&
    lifecycle !== "on_success" &&
    lifecycle !== "on_failure"
  ) {
    throw new Error(`Hook component "${componentId}" has invalid lifecycle`);
  }
  if (typeof command !== "string" || command.length === 0) {
    throw new Error(`Hook component "${componentId}" is missing hook.command`);
  }
  return { lifecycle, command, sourceDir };
}

async function loadCheckComponent(
  stateDir: string,
  componentId: string,
): Promise<{ checks: PolicyCheckInput[]; sourceDir: string }> {
  const sourceDir = join(stateDir, "components", "checks", componentId);
  const document = (await readYamlDocument(join(sourceDir, "component.yaml"))) as CheckComponentDocument;
  if (document.checks === undefined) {
    throw new Error(`Check component "${componentId}" is missing checks`);
  }
  if (!Array.isArray(document.checks)) {
    throw new Error(`Check component "${componentId}" has invalid checks`);
  }
  const checks = document.checks.map((check, index) => {
    const value = check as Record<string, unknown>;
    const name = value.name;
    const command = value.command;
    const timeoutSeconds = value.timeout_seconds;
    const onFail = value.on_fail;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`Check component "${componentId}" has invalid checks[${index}].name`);
    }
    if (typeof command !== "string" || command.length === 0) {
      throw new Error(`Check component "${componentId}" has invalid checks[${index}].command`);
    }
    if (timeoutSeconds !== undefined && timeoutSeconds !== null && (typeof timeoutSeconds !== "number" || timeoutSeconds <= 0)) {
      throw new Error(`Check component "${componentId}" has invalid checks[${index}].timeout_seconds`);
    }
    if (onFail !== undefined && onFail !== "retry" && onFail !== "fail" && onFail !== "ignore") {
      throw new Error(`Check component "${componentId}" has invalid checks[${index}].on_fail`);
    }
    return {
      name,
      command,
      timeout_seconds: typeof timeoutSeconds === "number" ? timeoutSeconds : null,
      on_fail: onFail === "fail" || onFail === "ignore" ? onFail : "retry",
    } satisfies PolicyCheckInput;
  });
  return { checks, sourceDir };
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const sourceStat = await stat(sourcePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, sourceStat.mode);
  }
}

function rewriteRelativeCommand(command: string, prefix: string): string {
  const match = /^\.\/(\S+)(.*)$/.exec(command.trim());
  if (!match) {
    return command;
  }
  return `./${prefix}/${match[1]}${match[2]}`;
}

async function mergeGlobalProjectConfig(configPath: string, projectId: string, projectPath: string): Promise<boolean> {
  const existed = await pathExists(configPath);
  let document: Record<string, unknown> = {};
  if (existed) {
    document = ((await readYamlDocument(configPath)) as Record<string, unknown> | null) ?? {};
  }
  const parsed = parseGlobalConduitConfigDocument(document);
  const existing = parsed.projects[projectId];
  if (existing && existing.path !== projectPath) {
    throw new Error(`Project id "${projectId}" is already configured for a different path`);
  }

  const root = (document.conduit ?? {}) as Record<string, unknown>;
  const projects = ((root.projects ?? {}) as Record<string, unknown>);
  projects[projectId] = { path: projectPath };
  root.projects = projects;
  document.conduit = root;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, stringifyYaml(document), "utf8");
  return !existed;
}

async function writeLocalProjectConfig(configPath: string, projectId: string): Promise<boolean> {
  const existed = await pathExists(configPath);
  let document: Record<string, unknown> = {};
  if (existed) {
    document = ((await readYamlDocument(configPath)) as Record<string, unknown> | null) ?? {};
  }

  const root = (document.conduit ?? {}) as Record<string, unknown>;
  root.project = { id: projectId };
  document.conduit = root;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, stringifyYaml(document), "utf8");
  return !existed;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeCheckComponentSelection(values: string[]): string[] {
  const deduped = dedupe(values);
  if (deduped.length <= 1) {
    return deduped;
  }
  return deduped.filter((value) => value !== "no-checks");
}

function hookRequiresGit(componentId: string): boolean {
  return componentId === "worktree-from-main";
}

function filterHookComponentsForProject(values: string[], hasGit: boolean): string[] {
  if (hasGit) {
    return values;
  }
  return values.filter((value) => !hookRequiresGit(value));
}

async function promptForSelections(context: PromptContext): Promise<PromptSelections> {
  const preset = await select({
    message: "Preset",
    default: context.defaultPreset,
    choices: context.presets.map((choice) => ({
      value: choice.id,
      name: choice.label,
    })),
  });
  const runnerComponent = await select({
    message: "Runner component",
    default: context.defaultRunnerComponent,
    choices: context.runnerComponents.map((choice) => ({
      value: choice.id,
      name: choice.label,
    })),
  });
  const beforeAttemptHookComponents =
    context.beforeAttemptHookComponents.length === 0
      ? []
      : await checkbox({
          message: "Before-attempt hooks",
          choices: context.beforeAttemptHookComponents.map((choice) => ({
            value: choice.id,
            name: choice.label,
            checked: context.defaultBeforeAttemptHookComponents.includes(choice.id),
          })),
        });
  const checkComponents = normalizeCheckComponentSelection(
    context.checkComponents.length === 0
      ? []
      : await checkbox({
          message: "Checks",
          choices: context.checkComponents.map((choice) => ({
            value: choice.id,
            name: choice.label,
            checked: context.defaultCheckComponents.includes(choice.id),
          })),
        }),
  );
  const optionalHookComponents =
    context.optionalHookComponents.length === 0
      ? []
      : await checkbox({
          message: "Optional hooks",
          choices: context.optionalHookComponents.map((choice) => ({
            value: choice.id,
            name: choice.label,
            checked: context.defaultOptionalHookComponents.includes(choice.id),
          })),
        });
  const projectIdAnswer = await input({
    message: "Project id",
    default: context.suggestedProjectId,
    validate: (value) => (sanitizeProjectId(value).length > 0 ? true : "Project id cannot be empty"),
  });

  return {
    preset,
    runnerComponent,
    beforeAttemptHookComponents,
    checkComponents,
    optionalHookComponents,
    projectId: projectIdAnswer || context.suggestedProjectId,
  };
}

export async function runInitCommand(
  deps: InitDeps,
  input: {
    preset: string;
    checks: string[];
    hooks: string[];
    runner: string | null;
    projectId: string | null;
    yes: boolean;
    force: boolean;
  },
): Promise<InitResult> {
  const installResult = await runInstallCommand({
    stdout: deps.stdout,
    config: deps.config,
  });

  const repoRoot = resolveProjectRoot(deps.cwd?.() ?? process.cwd());
  const hasGit = await isGitProject(repoRoot);
  const suggestedProjectId = sanitizeProjectId(basename(repoRoot));
  const localConfigPath = join(repoRoot, ".conduit", "config.yaml");
  const globalConfigPath = join(deps.config.stateDir, "config.yaml");
  const policyId = "default.v1";
  const policyDir = join(repoRoot, ".conduit", "policies", policyId);
  const policyPath = join(policyDir, "policy.yaml");

  if (!input.force && (await pathExists(policyPath))) {
    throw new Error(`Policy "${policyId}" already exists. Re-run with --force to overwrite.`);
  }

  const presetIds = await listPresetIds(deps.config.stateDir);
  const initialPresetId = input.preset;
  const initialPreset = await loadPreset(deps.config.stateDir, initialPresetId);

  const defaultRunnerComponent = (() => {
    const value = initialPreset.defaults?.runner_component;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Preset "${initialPresetId}" is missing defaults.runner_component`);
    }
    return value;
  })();

  let selectedPresetId = initialPresetId;
  let selectedRunnerInput = input.runner;
  let selectedCheckComponents = input.checks;
  let selectedBeforeAttemptHooks: string[] | null = null;
  let selectedOptionalHooks: string[] = [];
  let selectedProjectIdInput = input.projectId;

  const isInteractive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!input.yes && isInteractive) {
    const presetChoices = presetIds.map((id) => ({ id, label: id }));
    const runnerChoices = asStringArray(initialPreset.available?.runner_components, "available.runner_components").map((id) => ({
      id,
      label: id,
    }));
    const beforeAttemptChoices = filterHookComponentsForProject(
      asStringArray(
      initialPreset.available?.before_attempt_hook_components,
      "available.before_attempt_hook_components",
      ),
      hasGit,
    ).map((id) => ({
      id,
      label: id,
    }));
    const checkChoices = asStringArray(initialPreset.available?.check_components, "available.check_components").map((id) => ({
      id,
      label: id,
    }));
    const optionalHookChoices = asStringArray(
      initialPreset.available?.optional_hook_components,
      "available.optional_hook_components",
    ).map((id) => ({
      id,
      label: id,
    }));

    const selections = await (deps.promptSelections ?? promptForSelections)({
      presets: presetChoices,
      defaultPreset: initialPresetId,
      runnerComponents: runnerChoices,
      defaultRunnerComponent,
      beforeAttemptHookComponents: beforeAttemptChoices,
      defaultBeforeAttemptHookComponents: filterHookComponentsForProject(
        asStringArray(
          initialPreset.defaults?.before_attempt_hook_components,
          "defaults.before_attempt_hook_components",
        ),
        hasGit,
      ),
      checkComponents: checkChoices,
      defaultCheckComponents: asStringArray(initialPreset.defaults?.check_components, "defaults.check_components"),
      optionalHookComponents: optionalHookChoices,
      defaultOptionalHookComponents: asStringArray(
        initialPreset.defaults?.optional_hook_components,
        "defaults.optional_hook_components",
      ),
      suggestedProjectId,
    });

    selectedPresetId = selections.preset;
    selectedRunnerInput = selections.runnerComponent;
    selectedCheckComponents = selections.checkComponents;
    selectedBeforeAttemptHooks = selections.beforeAttemptHookComponents;
    selectedOptionalHooks = selections.optionalHookComponents;
    selectedProjectIdInput = selections.projectId;
  }

  const preset = selectedPresetId === initialPresetId ? initialPreset : await loadPreset(deps.config.stateDir, selectedPresetId);
  const projectId = selectedProjectIdInput ? sanitizeProjectId(selectedProjectIdInput) : suggestedProjectId;
  const defaultBeforeAttemptHooks = filterHookComponentsForProject(
    asStringArray(
      preset.defaults?.before_attempt_hook_components,
      "defaults.before_attempt_hook_components",
    ),
    hasGit,
  );
  const selectedBeforeAttemptHookComponents = selectedBeforeAttemptHooks ?? defaultBeforeAttemptHooks;
  const effectiveCheckComponents = normalizeCheckComponentSelection(
    selectedCheckComponents.length > 0
      ? selectedCheckComponents
      : asStringArray(preset.defaults?.check_components, "defaults.check_components"),
  );
  const selectedHookComponents = dedupe([
    ...selectedBeforeAttemptHookComponents,
    ...input.hooks,
    ...selectedOptionalHooks,
  ]);
  const gitRequiredHooks = selectedHookComponents.filter((componentId) => hookRequiresGit(componentId));
  if (!hasGit && gitRequiredHooks.length > 0) {
    throw new Error(
      `Selected hook component requires git: ${gitRequiredHooks.join(", ")}. Initialize a git repo or choose non-git hooks.`,
    );
  }

  let runner: { provider: string; model: string | null };
  if (selectedRunnerInput) {
    const runnerComponentPath = join(deps.config.stateDir, "components", "runners", selectedRunnerInput, "component.yaml");
    runner = (await pathExists(runnerComponentPath))
      ? await loadRunnerComponent(deps.config.stateDir, selectedRunnerInput)
      : parseRunnerRef(selectedRunnerInput);
  } else {
    const presetRunnerComponent = preset.defaults?.runner_component;
    if (typeof presetRunnerComponent !== "string" || presetRunnerComponent.length === 0) {
      throw new Error(`Preset "${selectedPresetId}" is missing defaults.runner_component`);
    }
    runner = await loadRunnerComponent(deps.config.stateDir, presetRunnerComponent);
  }

  await mkdir(policyDir, { recursive: true });

  const hooks: Record<"init" | "before_attempt" | "after_attempt" | "on_success" | "on_failure", string[]> = {
    init: [],
    before_attempt: [],
    after_attempt: [],
    on_success: [],
    on_failure: [],
  };

  for (const componentId of selectedHookComponents) {
    const hook = await loadHookComponent(deps.config.stateDir, componentId);
    const targetDir = join(policyDir, "hooks", componentId);
    await copyDirectory(hook.sourceDir, targetDir);
    hooks[hook.lifecycle].push(rewriteRelativeCommand(hook.command, `hooks/${componentId}`));
  }

  const checks: PolicyCheckInput[] = [];
  for (const componentId of effectiveCheckComponents) {
    const checkBundle = await loadCheckComponent(deps.config.stateDir, componentId);
    const targetDir = join(policyDir, "checks", componentId);
    if (await pathExists(checkBundle.sourceDir)) {
      await copyDirectory(checkBundle.sourceDir, targetDir);
    }
    for (const check of checkBundle.checks) {
      checks.push({
        ...check,
        command: rewriteRelativeCommand(check.command, `checks/${componentId}`),
      });
    }
  }

  const policyDocument = {
    policy_id: policyId,
    task_id: "default",
    runner,
    hooks,
    checks,
    retry: {
      max_attempts: 1,
    },
  };

  await writeFile(join(policyDir, "policy.yaml"), stringifyYaml(policyDocument), "utf8");
  await writeFile(
    join(policyDir, "prompt.md"),
    [
      "# Default Prompt",
      "",
      "Describe the task in the run input and make the requested change in the workspace.",
      "",
      "Use the attempt checks and hooks as the execution contract.",
      "",
    ].join("\n"),
    "utf8",
  );

  const createdLocalConfig = await writeLocalProjectConfig(localConfigPath, projectId);
  await mergeGlobalProjectConfig(globalConfigPath, projectId, repoRoot);

  return {
    project_id: projectId,
    project_path: repoRoot,
    policy_id: policyId,
    local_config_path: localConfigPath,
    global_config_path: globalConfigPath,
    created_local_config: createdLocalConfig,
    created_policy: true,
    installed_global_state: {
      created_state_dir: installResult.created_state_dir,
      created_config: installResult.created_config,
    },
  };
}

export function registerInitCommand(yargs: Argv, deps: InitDeps): void {
  yargs.command(
    "init",
    "Initialize the current repository with starter Conduit files",
    (cmd) =>
      cmd
        .option("preset", {
          type: "string",
          default: "basic",
          describe: "Bundled preset id to assemble",
        })
        .option("check", {
          type: "array",
          string: true,
          default: [],
          describe: "Check component id to include (repeatable)",
        })
        .option("runner", {
          type: "string",
          describe: "Runner component id or provider/model override",
        })
        .option("hook", {
          type: "array",
          string: true,
          default: [],
          describe: "Hook component id to include (repeatable)",
        })
        .option("project-id", {
          type: "string",
          describe: "Project id to register globally and locally",
        })
        .option("yes", {
          type: "boolean",
          default: false,
          describe: "Accept the preset defaults without prompting",
        })
        .option("force", {
          type: "boolean",
          default: false,
          describe: "Overwrite the generated default policy if it already exists",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "Emit JSON output",
        }),
    async (args) => {
      const result = await runInitCommand(deps, {
        preset: String(args.preset),
        checks: (args.check as string[] | undefined) ?? [],
        hooks: (args.hook as string[] | undefined) ?? [],
        runner: args.runner ? String(args.runner) : null,
        projectId: args["project-id"] ? String(args["project-id"]) : null,
        yes: Boolean(args.yes),
        force: Boolean(args.force),
      });

      if (args.json) {
        writeJson(deps.stdout, result);
        return;
      }

      deps.stdout.write(`project_id: ${result.project_id}\n`);
      deps.stdout.write(`project_path: ${result.project_path}\n`);
      deps.stdout.write(`policy_id: ${result.policy_id}\n`);
      deps.stdout.write(`local_config_path: ${result.local_config_path}\n`);
      deps.stdout.write(`global_config_path: ${result.global_config_path}\n`);
      deps.stdout.write("\n");
      deps.stdout.write("Next steps:\n");
      deps.stdout.write(`  conduit projects policies ${result.project_id}\n`);
      deps.stdout.write(`  conduit runs create --project ${result.project_id} --policy ${result.policy_id} --input '{\"task\":\"...\"}' --wait\n`);
    },
  );
}
