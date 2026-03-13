#!/usr/bin/env tsx
import process from "node:process";
import path from "node:path";

import { main } from "./src/cli/index";

export { main };

if (path.basename(process.argv[1] ?? "") === "cli.ts") {
  void main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Error: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
