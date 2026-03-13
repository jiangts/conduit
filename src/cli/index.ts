#!/usr/bin/env tsx
import process from "node:process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { loadConduitConfig, loadGlobalConduitConfig, resolveStateDbPath } from "../config";
import { createServer } from "../server";
import { runChatCommand } from "./chat";
import type { InitDeps } from "./init";
import { registerInitCommand } from "./init";
import { registerInstallCommand } from "./install";
import { registerProjectCommands } from "./projects";
import { parseRunnerRef } from "./runner-ref";
import { registerRuntimeCommands } from "./runtime";
import { registerRunCommands } from "./runs";

interface OutputWriter {
  write(chunk: string): unknown;
}

export interface CliDeps {
  loadConfig?: typeof loadConduitConfig;
  loadGlobalConfig?: typeof loadGlobalConduitConfig;
  stdout?: OutputWriter;
  stderr?: OutputWriter;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  serveFn?: (input: { config: Awaited<ReturnType<typeof loadConduitConfig>>; host: string; port: number }) => Promise<void>;
  initInteractive?: boolean;
  promptInitSelections?: InitDeps["promptSelections"];
}

const TOP_LEVEL_COMMANDS = new Set(["chat", "runs", "projects", "runtime", "install", "init", "serve"]);

function normalizeArgv(argv: string[]): string[] {
  if (argv.length === 0) {
    return argv;
  }
  const first = argv[0];
  if (first.startsWith("-") || TOP_LEVEL_COMMANDS.has(first)) {
    return argv;
  }
  return ["chat", ...argv];
}

export async function main(argv: string[] = hideBin(process.argv), deps: CliDeps = {}): Promise<number> {
  const normalizedArgv = normalizeArgv(argv);
  const loadConfig = deps.loadConfig ?? loadConduitConfig;
  const loadGlobalConfig = deps.loadGlobalConfig ?? loadGlobalConduitConfig;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const serveFn =
    deps.serveFn ??
    (async (input: { config: Awaited<ReturnType<typeof loadConduitConfig>>; host: string; port: number }) => {
      const app = await createServer(input.config);
      await app.listen({ host: input.host, port: input.port });
    });
  const config =
    normalizedArgv[0] === "install" || normalizedArgv[0] === "init" ? await loadGlobalConfig() : await loadConfig();
  const baseUrlDefault = `http://127.0.0.1:${config.server.port}`;

  let exitCode = 0;
  const setExitCode = (value: number) => {
    exitCode = value;
  };

  const parser = yargs(normalizedArgv)
    .scriptName("conduit")
    .parserConfiguration({
      "populate--": true,
    })
    .option("base-url", {
      type: "string",
      default: baseUrlDefault,
      global: true,
      describe: "Conduit server base URL for runs/projects commands",
    })
    .command(
      "serve",
      "Run the local Conduit runtime in the foreground",
      (cmd) =>
        cmd
          .option("host", {
            type: "string",
            default: "127.0.0.1",
            describe: "Host interface to bind for the foreground runtime",
          })
          .option("port", {
            type: "number",
            default: config.server.port,
            describe: "Port to bind for the foreground runtime",
          }),
      async (args) => {
        await serveFn({
          config,
          host: String(args.host),
          port: Number(args.port),
        });
      },
    )
    .command(
      "chat <prompt>",
      "Run a one-shot chat prompt locally",
      (cmd) =>
        cmd
          .positional("prompt", {
            type: "string",
            demandOption: true,
          })
          .option("runner", {
            type: "string",
            default: config.defaultRunner,
            describe: "Runner override as provider or provider/model",
          })
          .option("resume", {
            type: "string",
            describe: "Provider session id to resume",
          })
          .option("cwd", {
            type: "string",
            default: process.cwd(),
            describe: "Working directory for the provider process",
          })
          .option("db", {
            type: "string",
            default: resolveStateDbPath(config),
            describe: "SQLite path used by SqliteAgentQueueStore",
          }),
      async (args) => {
        const passthroughArgs = Array.isArray(args["--"])
          ? args["--"].filter((value): value is string => typeof value === "string" && value.length > 0)
          : [];
        setExitCode(
          await runChatCommand(
            {
              prompt: String(args.prompt),
              runner: parseRunnerRef(String(args.runner)),
              resume: args.resume ? String(args.resume) : undefined,
              cwd: String(args.cwd),
              db: String(args.db),
              passthroughArgs,
            },
            config,
            { stdout, stderr },
          ),
        );
      },
    )
    .help()
    .demandCommand(1);

  registerRunCommands(parser, { stdout, fetchFn, sleep, setExitCode, config });
  registerProjectCommands(parser, { stdout, config });
  registerRuntimeCommands(parser, { stdout, fetchFn, sleep, config });
  registerInstallCommand(parser, { stdout, config });
  registerInitCommand(parser, {
    stdout,
    stderr,
    config,
    interactive: deps.initInteractive,
    promptSelections: deps.promptInitSelections,
  });

  parser.exitProcess(false);
  parser.fail((message, error) => {
    throw error ?? new Error(message);
  });

  try {
    await parser.parseAsync();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`Error: ${message}\n`);
    return 1;
  }

  return exitCode;
}
