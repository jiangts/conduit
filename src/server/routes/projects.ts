import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ConduitConfig } from "../../config";
import { HttpError } from "../http-error";
import { getProject, getResolvedPolicy, listProjectPolicies, listProjects } from "../../config";

const ErrorResponseSchema = z.object({ error: z.string() });
const ProjectParamsSchema = z.object({
  projectId: z.string().min(1),
});
const PolicyParamsSchema = z.object({
  projectId: z.string().min(1),
  policyId: z.string().min(1),
});
const RunnerSchema = z.object({
  provider: z.string(),
  model: z.string().nullable(),
});
const PolicySummarySchema = z.object({
  policy_id: z.string(),
  task_id: z.string(),
  path: z.string(),
});
const ProjectSummarySchema = z.object({
  project_id: z.string(),
  path: z.string(),
});
const ProjectDetailSchema = ProjectSummarySchema.extend({
  default_branch: z.string().nullable(),
  policies: z.array(PolicySummarySchema),
});
const ResolvedPolicySchema = z.object({
  policy_id: z.string(),
  task_id: z.string(),
  runner: RunnerSchema,
  hooks: z.object({
    init: z.array(z.string()),
    before_attempt: z.array(z.string()),
    after_attempt: z.array(z.string()),
    on_success: z.array(z.string()),
    on_failure: z.array(z.string()),
  }),
  checks: z.array(
    z.object({
      name: z.string(),
      command: z.string(),
      timeout_seconds: z.number().int().positive().nullable(),
      on_fail: z.enum(["retry", "fail", "ignore"]),
    }),
  ),
  retry: z.object({
    max_attempts: z.number().int().positive(),
    timeout_seconds: z.number().int().positive().nullable(),
    escalation: z.array(RunnerSchema),
  }),
  policy_dir: z.string(),
});

export function registerProjectRoutes(app: FastifyInstance, config: ConduitConfig): void {
  app.get(
    "/projects",
    {
      schema: {
        tags: ["projects"],
        response: {
          200: z.array(ProjectSummarySchema),
        },
      },
    },
    async () => listProjects(config),
  );

  app.get(
    "/projects/:projectId",
    {
      schema: {
        tags: ["projects"],
        params: ProjectParamsSchema,
        response: {
          200: ProjectDetailSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as z.infer<typeof ProjectParamsSchema>;
      const project = await getProject(config, params.projectId);
      if (!project) {
        throw new HttpError(404, `Project "${params.projectId}" not found`);
      }
      return project;
    },
  );

  app.get(
    "/projects/:projectId/policies",
    {
      schema: {
        tags: ["projects"],
        params: ProjectParamsSchema,
        response: {
          200: z.array(PolicySummarySchema),
          404: ErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as z.infer<typeof ProjectParamsSchema>;
      if (!config.projects[params.projectId]) {
        throw new HttpError(404, `Project "${params.projectId}" not found`);
      }
      return listProjectPolicies(config, params.projectId);
    },
  );

  app.get(
    "/projects/:projectId/policies/:policyId",
    {
      schema: {
        tags: ["projects"],
        params: PolicyParamsSchema,
        response: {
          200: ResolvedPolicySchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const params = request.params as z.infer<typeof PolicyParamsSchema>;
      if (!config.projects[params.projectId]) {
        throw new HttpError(404, `Project "${params.projectId}" not found`);
      }
      const policy = await getResolvedPolicy(config, params.projectId, params.policyId);
      if (!policy) {
        throw new HttpError(404, `Policy "${params.policyId}" not found for project "${params.projectId}"`);
      }
      return policy;
    },
  );
}
