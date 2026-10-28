import { defineConfig } from "vitest/config";

// One `npm test` runs all three packages as Vitest projects. Coverage is
// measured on the shared package (the simulation, protocol, codecs and
// prediction), where the lab asks for >= 85 %.
export default defineConfig({
  test: {
    projects: ["shared", "server", "client"].map((name) => ({
      test: {
        name,
        root: name,
        include: ["test/**/*.test.ts"],
        environment: "node",
      },
    })),
    coverage: {
      provider: "v8",
      include: ["shared/**/*.ts"],
      exclude: ["shared/test/**"],
      reporter: ["text-summary", "text", "json-summary"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
