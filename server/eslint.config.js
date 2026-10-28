export default [
  {
    files: ["src/**/*.js", "test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setImmediate: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        EventTarget: "readonly",
        CustomEvent: "readonly",
        clearImmediate: "readonly",
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
