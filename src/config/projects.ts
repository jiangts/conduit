import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ConduitConfig } from "./conduit";
import { loadPolicy } from "./policy";
import type { ResolvedPolicy, RunnerRef } from "../types/run-types";

export interface ProjectSummary {
  project_id: string;
  path: string;
}

export interface PolicySummary {
  policy_id: string;
  task_id: string;
  path: string;
}

export interface ProjectDetail extends ProjectSummary {
  default_branch: string | null;
  policies: PolicySummary[];
}

async function readDefaultBranch(projectPath: string): Promise<string | null> {
  try {
    const trimmed = (await readFile(join(projectPath, ".git", "HEAD"), "utf8")).trim();
    if (trimmed.startsWith("ref: refs/heads/")) {
      return trimmed.slice("ref: refs/heads/".length);
    }
    if (trimmed.startsWith("ref: ")) {
      return trimmed.slice(5);
    }
    return trimmed || null;
  } catch {
    return null;
  }
}

async function listPolicyIds(projectPath: string): Promise<string[]> {
  try {
    const policiesDir = join(projectPath, ".conduit", "policies");
    const entries = await readdir(policiesDir, { withFileTypes: true });
    const policyIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    policyIds.sort((left, right) => left.localeCompare(right));
    return policyIds;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function resolveDefaultRunner(config: ConduitConfig): RunnerRef {
  return {
    provider: config.defaultRunner,
    model: null,
  };
}

export async function listProjects(config: ConduitConfig): Promise<ProjectSummary[]> {
  return Object.entries(config.projects)
    .map(([projectId, project]) => ({
      project_id: projectId,
      path: project.path,
    }))
    .sort((left, right) => left.project_id.localeCompare(right.project_id));
}

export async function getProject(config: ConduitConfig, projectId: string): Promise<ProjectDetail | null> {
  const project = config.projects[projectId];
  if (!project) {
    return null;
  }

  return {
    project_id: projectId,
    path: project.path,
    default_branch: await readDefaultBranch(project.path),
    policies: await listProjectPolicies(config, projectId),
  };
}

export async function listProjectPolicies(config: ConduitConfig, projectId: string): Promise<PolicySummary[]> {
  const project = config.projects[projectId];
  if (!project) {
    return [];
  }

  const defaultRunner = resolveDefaultRunner(config);
  const policyIds = await listPolicyIds(project.path);
  const policies = await Promise.all(
    policyIds.map(async (policyId) => {
      const policy = await loadPolicy(project.path, policyId, defaultRunner);
      return {
        policy_id: policy.policy_id,
        task_id: policy.task_id,
        path: policy.policy_dir,
      };
    }).map(async (task) => {
      try {
        return await task;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return null;
        }
        throw error;
      }
    }),
  );
  return policies.filter((policy): policy is PolicySummary => policy !== null);
}

export async function getResolvedPolicy(config: ConduitConfig, projectId: string, policyId: string): Promise<ResolvedPolicy | null> {
  const project = config.projects[projectId];
  if (!project) {
    return null;
  }

  try {
    return await loadPolicy(project.path, policyId, resolveDefaultRunner(config));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
