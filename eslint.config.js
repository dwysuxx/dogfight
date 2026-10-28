// One flat config for the whole workspace (ESLint finds it from every package).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "server/logs/**", "coverage/**", "playwright-report/**", "test-results/**", "eslint.config.js"],
  },
  // Type-checked rules read the TypeScript types, so they catch floating
  // promises and values that are secretly `any` (JSON, catch, fetch...).
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: "error",
      "@typescript-eslint/no-explicit-any": "error",
      // Every `as` cast must be an explicit, commented exception (the lab allows < 5).
      // `as const` is not a cast and stays allowed.
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Test fakes implement async APIs without awaiting anything.
    files: ["**/test/**/*.ts", "e2e/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    // The shared simulation must be deterministic and runtime-neutral.
    files: ["shared/sim/**/*.ts", "shared/net/**/*.ts", "shared/codec/**/*.ts", "shared/protocol.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Use the seeded world.rng: the sim must be deterministic." },
        { object: "Date", property: "now", message: "The sim steps with a fixed dt; it never reads the clock." },
      ],
    },
  },
);
