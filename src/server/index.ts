#!/usr/bin/env tsx
import process from "node:process";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { ZodError, z } from "zod";

import { type ConduitConfig, loadConduitConfig, resolveStateDbPath } from "../config";
import { HttpError } from "./http-error";
import { registerChatRoutes, redactErrorMessage } from "./routes/chat";
import { registerProjectRoutes } from "./routes/projects";
import { registerPlaygroundRoutes } from "./routes/ui/playground";
import { registerRunRoutes } from "./routes/runs";
import { registerStatusRoutes } from "./routes/ui/status";
import { ConduitStatusReader } from "./status-reader";
import { ConduitRunManager } from "../runs/manager";

const HealthzResponseSchema = z.object({ ok: z.boolean() });

export async function createServer(config: ConduitConfig) {
  const app = Fastify({
    logger: config.server.debug
      ? {
          level: "debug",
        }
      : false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  if (config.server.enableDocs) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "Conduit API",
          description: "HTTP interface for local runner execution and thread controls",
          version: "1.0.0",
        },
        servers: [{ url: "/" }],
        tags: [
          { name: "chat", description: "One-shot and thread-oriented chat execution" },
          { name: "runs", description: "Deterministic run lifecycle and check-output execution" },
          { name: "projects", description: "Project and policy discovery" },
          { name: "health", description: "Service health checks" },
        ],
      },
      transform: jsonSchemaTransform,
    });

    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: {
        docExpansion: "list",
        deepLinking: true,
      },
      staticCSP: true,
    });
  }

  app.get(
    "/healthz",
    {
      schema: {
        tags: ["health"],
        response: {
          200: HealthzResponseSchema,
        },
      },
    },
    async () => ({ ok: true }),
  );

  app.get(
    "/",
    {
      schema: {
        hide: true,
      },
    },
    async (_request, reply) => {
      if (config.server.enableDocs) {
        return reply.redirect("/docs");
      }
      return { ok: true };
    },
  );

  const stateDbPath = resolveStateDbPath(config);
  const runManager = new ConduitRunManager(config, stateDbPath);
  const statusReader = new ConduitStatusReader(stateDbPath);
  const serverStartedAt = new Date();
  runManager.start();
  app.addHook("onClose", async () => {
    runManager.close();
    statusReader.close();
  });

  registerChatRoutes(app, config);
  registerRunRoutes(app, runManager);
  registerProjectRoutes(app, config);
  registerPlaygroundRoutes(app, config);
  registerStatusRoutes(app, config, runManager, statusReader, serverStartedAt);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.code(400).send({ error: "Request validation failed" });
      return;
    }
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const rawMessage = error instanceof Error ? error.message : "Internal server error";
    const message = redactErrorMessage(statusCode, rawMessage, config.server.debug);
    void reply.code(statusCode).send({ error: message });
  });

  return app;
}

export async function main(): Promise<void> {
  const config = await loadConduitConfig();
  const app = await createServer(config);
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? config.server.port);

  await app.listen({ host, port });
}
