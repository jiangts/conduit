import { access, chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Argv } from "yargs";

import type { ConduitConfig } from "../config";
import { resolveConduitConfigPaths } from "../config";

interface OutputWriter {
  write(chunk: string): unknown;
}

export interface InstallDeps {
  stdout: OutputWriter;
  config: Pick<ConduitConfig, "stateDir">;
  configPaths?: () => string[];
  force?: boolean;
}

interface AssetCopySummary {
  copied_files: number;
  overwritten_files: number;
  skipped_existing_files: number;
}

interface InstallResult {
  state_dir: string;
  config_path: string;
  created_state_dir: boolean;
  created_config: boolean;
  created_runs_dir: boolean;
  assets: {
    package_version: string;
    presets: AssetCopySummary;
    components: AssetCopySummary;
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

async function ensureDirectory(path: string): Promise<boolean> {
  const existed = await pathExists(path);
  if (!existed) {
    await mkdir(path, { recursive: true });
  }
  return !existed;
}

async function readPackageVersion(): Promise<string> {
  const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const raw = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("Unable to determine Conduit package version");
  }
  return parsed.version;
}

async function copyBundledDirectory(
  sourceDir: string,
  targetDir: string,
  options: { force: boolean },
): Promise<AssetCopySummary> {
  const summary: AssetCopySummary = {
    copied_files: 0,
    overwritten_files: 0,
    skipped_existing_files: 0,
  };

  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = `${sourceDir}/${entry.name}`;
    const targetPath = `${targetDir}/${entry.name}`;

    if (entry.isDirectory()) {
      const nestedSummary = await copyBundledDirectory(sourcePath, targetPath, options);
      summary.copied_files += nestedSummary.copied_files;
      summary.overwritten_files += nestedSummary.overwritten_files;
      summary.skipped_existing_files += nestedSummary.skipped_existing_files;
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const targetExists = await pathExists(targetPath);
    if (targetExists && !options.force) {
      summary.skipped_existing_files += 1;
      continue;
    }

    const sourceStat = await stat(sourcePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, sourceStat.mode);

    if (targetExists) {
      summary.overwritten_files += 1;
    } else {
      summary.copied_files += 1;
    }
  }

  return summary;
}

async function writeAssetStamp(rootDir: string, packageVersion: string): Promise<void> {
  await writeFile(
    `${rootDir}/.bundle-meta.json`,
    `${JSON.stringify(
      {
        package_version: packageVersion,
        installed_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function bundledAssetsRoot(): string {
  return fileURLToPath(new URL("../../bundled-assets", import.meta.url));
}

export async function runInstallCommand(deps: InstallDeps): Promise<InstallResult> {
  const configPaths = deps.configPaths?.() ?? resolveConduitConfigPaths();
  const configPath = configPaths[0];
  let existingConfigPath = configPath;
  let createdConfig = true;

  for (const candidatePath of configPaths) {
    try {
      await access(candidatePath);
      existingConfigPath = candidatePath;
      createdConfig = false;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  const createdStateDir = await ensureDirectory(deps.config.stateDir);
  const createdRunsDir = await ensureDirectory(`${deps.config.stateDir}/runs`);
  await mkdir(dirname(existingConfigPath), { recursive: true });

  if (createdConfig) {
    await writeFile(
      existingConfigPath,
      ["conduit:", "  projects: {}", ""].join("\n"),
      "utf8",
    );
  }

  const assetsRoot = bundledAssetsRoot();
  const packageVersion = await readPackageVersion();
  const presetsSummary = await copyBundledDirectory(`${assetsRoot}/presets`, `${deps.config.stateDir}/presets`, {
    force: deps.force ?? false,
  });
  const componentsSummary = await copyBundledDirectory(
    `${assetsRoot}/components`,
    `${deps.config.stateDir}/components`,
    {
      force: deps.force ?? false,
    },
  );
  await writeAssetStamp(`${deps.config.stateDir}/presets`, packageVersion);
  await writeAssetStamp(`${deps.config.stateDir}/components`, packageVersion);

  return {
    state_dir: deps.config.stateDir,
    config_path: existingConfigPath,
    created_state_dir: createdStateDir,
    created_config: createdConfig,
    created_runs_dir: createdRunsDir,
    assets: {
      package_version: packageVersion,
      presets: presetsSummary,
      components: componentsSummary,
    },
  };
}

export function registerInstallCommand(yargs: Argv, deps: InstallDeps): void {
  yargs.command(
    "install",
    "Initialize global Conduit state",
    (cmd) =>
      cmd
        .option("json", {
          type: "boolean",
          default: false,
          describe: "Emit JSON output",
        })
        .option("force", {
          type: "boolean",
          default: false,
          describe: "Overwrite bundled preset and component files in the global Conduit state",
        }),
    async (args) => {
      const result = await runInstallCommand({
        ...deps,
        force: args.force,
      });
      if (args.json) {
        writeJson(deps.stdout, result);
        return;
      }

      deps.stdout.write(`state_dir: ${result.state_dir}\n`);
      deps.stdout.write(`config_path: ${result.config_path}\n`);
      deps.stdout.write(`created_state_dir: ${result.created_state_dir}\n`);
      deps.stdout.write(`created_config: ${result.created_config}\n`);
      deps.stdout.write(`created_runs_dir: ${result.created_runs_dir}\n`);
      deps.stdout.write(`bundled_assets_version: ${result.assets.package_version}\n`);
      deps.stdout.write(
        `presets: copied=${result.assets.presets.copied_files} overwritten=${result.assets.presets.overwritten_files} skipped=${result.assets.presets.skipped_existing_files}\n`,
      );
      deps.stdout.write(
        `components: copied=${result.assets.components.copied_files} overwritten=${result.assets.components.overwritten_files} skipped=${result.assets.components.skipped_existing_files}\n`,
      );
      deps.stdout.write("\n");
      deps.stdout.write("Next steps:\n");
      deps.stdout.write("  conduit init\n");
      deps.stdout.write("  conduit serve\n");
      deps.stdout.write("  conduit runtime start\n");
    },
  );
}
