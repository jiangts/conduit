import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Argv } from "yargs";

import type { ConduitConfig } from "../config";

interface OutputWriter {
  write(chunk: string): unknown;
}

export interface RuntimeDeps {
  stdout: OutputWriter;
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  config: Pick<ConduitConfig, "stateDir">;
  spawnFn?: typeof spawn;
  killFn?: typeof process.kill;
}

interface RuntimeState {
  base_url: string;
  pid: number | null;
  started_at: string;
}

function writeJson(writer: OutputWriter, value: unknown): void {
  writer.write(`${JSON.stringify(value, null, 2)}\n`);
}

function runtimeStatePath(stateDir: string): string {
  return join(stateDir, "runtime.json");
}

async function readRuntimeState(stateDir: string): Promise<RuntimeState | null> {
  try {
    const raw = await readFile(runtimeStatePath(stateDir), "utf8");
    return JSON.parse(raw) as RuntimeState;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeRuntimeState(stateDir: string, state: RuntimeState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(runtimeStatePath(stateDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function clearRuntimeState(stateDir: string): Promise<void> {
  await rm(runtimeStatePath(stateDir), { force: true });
}

async function isRuntimeHealthy(baseUrl: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchFn(`${baseUrl.replace(/\/$/, "")}/healthz`);
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

function parseBaseUrl(baseUrl: string): { host: string; port: string } {
  const url = new URL(baseUrl);
  return {
    host: url.hostname,
    port: url.port || (url.protocol === "https:" ? "443" : "80"),
  };
}

function runtimeServerEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "server.ts");
}

function runtimeSpawnCommand(): { command: string; args: string[] } {
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["tsx", runtimeServerEntryPath()],
  };
}

async function waitForHealthy(
  baseUrl: string,
  fetchFn: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isRuntimeHealthy(baseUrl, fetchFn)) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

export function registerRuntimeCommands(yargs: Argv, deps: RuntimeDeps): void {
  yargs.command(
    "runtime <command>",
    "Manage the local Conduit runtime",
    (runtimeYargs) => {
      runtimeYargs.command(
        "status",
        "Check whether the local runtime is reachable",
        (cmd) =>
          cmd.option("json", {
            type: "boolean",
            default: false,
            describe: "Emit JSON output",
          }),
        async (args) => {
          const baseUrl = String(args.baseUrl);
          const healthy = await isRuntimeHealthy(baseUrl, deps.fetchFn);
          const state = await readRuntimeState(deps.config.stateDir);
          const payload = {
            base_url: baseUrl,
            reachable: healthy,
            pid: state?.base_url === baseUrl ? state.pid : null,
            started_at: state?.base_url === baseUrl ? state.started_at : null,
          };
          if (args.json) {
            writeJson(deps.stdout, payload);
            return;
          }
          deps.stdout.write(`base_url: ${baseUrl}\n`);
          deps.stdout.write(`reachable: ${healthy}\n`);
          if (payload.pid !== null) {
            deps.stdout.write(`pid: ${payload.pid}\n`);
          }
        },
      );

      runtimeYargs.command(
        "start",
        "Start the local Conduit runtime in the background",
        (cmd) =>
          cmd.option("json", {
            type: "boolean",
            default: false,
            describe: "Emit JSON output",
          }),
        async (args) => {
          const baseUrl = String(args.baseUrl);
          if (await isRuntimeHealthy(baseUrl, deps.fetchFn)) {
            const state = await readRuntimeState(deps.config.stateDir);
            const payload = {
              base_url: baseUrl,
              started: false,
              already_running: true,
              pid: state?.base_url === baseUrl ? state.pid : null,
            };
            if (args.json) {
              writeJson(deps.stdout, payload);
              return;
            }
            deps.stdout.write(`runtime already running at ${baseUrl}\n`);
            return;
          }

          const spawnFn = deps.spawnFn ?? spawn;
          const { host, port } = parseBaseUrl(baseUrl);
          const launch = runtimeSpawnCommand();
          const child = spawnFn(launch.command, launch.args, {
            detached: true,
            stdio: "ignore",
            env: {
              ...process.env,
              HOST: host,
              PORT: port,
            },
          }) as ChildProcess;
          child.unref();

          const healthy = await waitForHealthy(baseUrl, deps.fetchFn, deps.sleep);
          if (!healthy) {
            throw new Error(`Failed to start Conduit runtime at ${baseUrl}`);
          }

          await writeRuntimeState(deps.config.stateDir, {
            base_url: baseUrl,
            pid: child.pid ?? null,
            started_at: new Date().toISOString(),
          });

          const payload = {
            base_url: baseUrl,
            started: true,
            already_running: false,
            pid: child.pid ?? null,
          };
          if (args.json) {
            writeJson(deps.stdout, payload);
            return;
          }
          deps.stdout.write(`started runtime at ${baseUrl}\n`);
          if (child.pid) {
            deps.stdout.write(`pid: ${child.pid}\n`);
          }
        },
      );

      runtimeYargs.command(
        "stop",
        "Stop the local Conduit runtime",
        (cmd) =>
          cmd.option("json", {
            type: "boolean",
            default: false,
            describe: "Emit JSON output",
          }),
        async (args) => {
          const baseUrl = String(args.baseUrl);
          const state = await readRuntimeState(deps.config.stateDir);
          if (!state || state.base_url !== baseUrl || state.pid === null) {
            const payload = {
              base_url: baseUrl,
              stopped: false,
              found: false,
            };
            if (args.json) {
              writeJson(deps.stdout, payload);
              return;
            }
            deps.stdout.write(`no managed runtime found for ${baseUrl}\n`);
            return;
          }

          const killFn = deps.killFn ?? process.kill;
          let signaled = false;
          try {
            killFn(state.pid, "SIGTERM");
            signaled = true;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ESRCH") {
              throw error;
            }
          }

          await clearRuntimeState(deps.config.stateDir);
          const payload = {
            base_url: baseUrl,
            stopped: signaled,
            found: true,
            pid: state.pid,
          };
          if (args.json) {
            writeJson(deps.stdout, payload);
            return;
          }
          deps.stdout.write(`stopped runtime for ${baseUrl}\n`);
          deps.stdout.write(`pid: ${state.pid}\n`);
        },
      );

      return runtimeYargs.demandCommand(1);
    },
  );
}
