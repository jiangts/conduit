import type { Argv } from "yargs";

import type { ConduitConfig } from "../config";
import { getProject, getResolvedPolicy, listProjectPolicies, listProjects } from "../config";

interface OutputWriter {
  write(chunk: string): unknown;
}

interface ProjectSummary {
  project_id: string;
  path: string;
}

interface PolicySummary {
  policy_id: string;
  task_id: string;
  path: string;
}

interface ProjectDetail extends ProjectSummary {
  default_branch: string | null;
  policies: PolicySummary[];
}

interface ResolvedPolicy {
  policy_id: string;
  task_id: string;
  runner: {
    provider: string;
    model: string | null;
  };
  hooks: {
    init: string[];
    before_attempt: string[];
    after_attempt: string[];
    on_success: string[];
    on_failure: string[];
  };
  checks: Array<{
    name: string;
    command: string;
    timeout_seconds: number | null;
    on_fail: "retry" | "fail" | "ignore";
  }>;
  retry: {
    max_attempts: number;
    timeout_seconds: number | null;
    escalation: Array<{
      provider: string;
      model: string | null;
    }>;
  };
  policy_dir: string;
}

function writeJson(writer: OutputWriter, value: unknown): void {
  writer.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function registerProjectCommands(
  yargs: Argv,
  context: { stdout: OutputWriter; config: ConduitConfig },
): void {
  yargs.command(
    "projects <command>",
    "Inspect configured projects and policies",
    (projectsYargs) => {
      projectsYargs.command(
        "list",
        "List configured projects",
        (cmd) =>
          cmd.option("json", {
            type: "boolean",
            default: false,
            describe: "Emit JSON output",
          }),
        async (args) => {
          const projects = await listProjects(context.config);
          if (args.json) {
            writeJson(context.stdout, projects);
            return;
          }
          for (const project of projects) {
            context.stdout.write(`${project.project_id}\t${project.path}\n`);
          }
        },
      );

      projectsYargs.command(
        "get <projectId>",
        "Get project details",
        (cmd) =>
          cmd
            .positional("projectId", {
              type: "string",
              demandOption: true,
            })
            .option("json", {
              type: "boolean",
              default: false,
              describe: "Emit JSON output",
            }),
        async (args) => {
          const project = await getProject(context.config, String(args.projectId));
          if (!project) {
            throw new Error(`Project "${String(args.projectId)}" not found`);
          }
          if (args.json) {
            writeJson(context.stdout, project);
            return;
          }
          context.stdout.write(`project_id: ${project.project_id}\n`);
          context.stdout.write(`path: ${project.path}\n`);
          context.stdout.write(`default_branch: ${project.default_branch ?? "(unknown)"}\n`);
          if (project.policies.length === 0) {
            context.stdout.write("policies: (none)\n");
            return;
          }
          context.stdout.write("policies:\n");
          for (const policy of project.policies) {
            context.stdout.write(`- ${policy.policy_id} (${policy.task_id}) ${policy.path}\n`);
          }
        },
      );

      projectsYargs.command(
        "policies <projectId>",
        "List project policies",
        (cmd) =>
          cmd
            .positional("projectId", {
              type: "string",
              demandOption: true,
            })
            .option("json", {
              type: "boolean",
              default: false,
              describe: "Emit JSON output",
            }),
        async (args) => {
          if (!context.config.projects[String(args.projectId)]) {
            throw new Error(`Project "${String(args.projectId)}" not found`);
          }
          const policies = await listProjectPolicies(context.config, String(args.projectId));
          if (args.json) {
            writeJson(context.stdout, policies);
            return;
          }
          for (const policy of policies) {
            context.stdout.write(`${policy.policy_id}\t${policy.task_id}\t${policy.path}\n`);
          }
        },
      );

      projectsYargs.command(
        "policy <projectId> <policyId>",
        "Get a resolved policy",
        (cmd) =>
          cmd
            .positional("projectId", {
              type: "string",
              demandOption: true,
            })
            .positional("policyId", {
              type: "string",
              demandOption: true,
            })
            .option("json", {
              type: "boolean",
              default: false,
              describe: "Emit JSON output",
            }),
        async (args) => {
          if (!context.config.projects[String(args.projectId)]) {
            throw new Error(`Project "${String(args.projectId)}" not found`);
          }
          const policy = await getResolvedPolicy(context.config, String(args.projectId), String(args.policyId));
          if (!policy) {
            throw new Error(
              `Policy "${String(args.policyId)}" not found for project "${String(args.projectId)}"`,
            );
          }
          if (args.json) {
            writeJson(context.stdout, policy);
            return;
          }
          context.stdout.write(`policy_id: ${policy.policy_id}\n`);
          context.stdout.write(`task_id: ${policy.task_id}\n`);
          context.stdout.write(`runner: ${policy.runner.provider}${policy.runner.model ? ` (${policy.runner.model})` : ""}\n`);
          context.stdout.write(`policy_dir: ${policy.policy_dir}\n`);
          context.stdout.write(`retry: max_attempts=${policy.retry.max_attempts}, timeout_seconds=${policy.retry.timeout_seconds ?? "null"}\n`);
          if (policy.checks.length === 0) {
            context.stdout.write("checks: (none)\n");
          } else {
            context.stdout.write("checks:\n");
            for (const check of policy.checks) {
              context.stdout.write(
                `- ${check.name}: ${check.command} [on_fail=${check.on_fail}, timeout_seconds=${check.timeout_seconds ?? "null"}]\n`,
              );
            }
          }
        },
      );

      return projectsYargs.demandCommand(1);
    },
  );
}
