import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "cli.ts",
    server: "server.ts",
    index: "src/index.ts",
  },
  format: ["esm", "cjs"],
  splitting: false,
  dts: true,
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
