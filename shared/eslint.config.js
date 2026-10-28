// The shared package may only use language features and the few globals that
// exist in BOTH runtimes. No window/document, no Buffer/process: if one of
// those sneaks into the simulation, lint fails before the browser does.
export default [
  {
    files: ["sim/**/*.js", "protocol/**/*.js", "codec/**/*.js", "net/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        EventTarget: "readonly",
        CustomEvent: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: "error",
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Use the seeded world.rng: the sim must be deterministic." },
        { object: "Date", property: "now", message: "The sim steps with a fixed dt; it never reads the clock." },
      ],
    },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
  },
];
