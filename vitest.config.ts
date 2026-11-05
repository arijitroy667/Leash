import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["packages/*/test/**/*.test.ts", "apps/demo/test/**/*.test.ts"] } });
