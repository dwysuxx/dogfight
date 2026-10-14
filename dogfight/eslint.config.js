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
