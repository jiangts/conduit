#!/usr/bin/env tsx
import process from "node:process";
import path from "node:path";

import { createServer, main } from "./src/server/index";

export { createServer };

if (path.basename(process.argv[1] ?? "") === "server.ts") {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
