// One flat config for the whole workspace (ESLint finds it from every package).
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "server/logs/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
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
