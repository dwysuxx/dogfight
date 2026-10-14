export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        performance: "readonly",
        location: "readonly",
        URLSearchParams: "readonly",
        console: "readonly",
        EventTarget: "readonly",
        Event: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: "error",
    },
  },
];
