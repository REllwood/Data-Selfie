// Run with `npm run lint`, which fetches a pinned ESLint through npx so the
// project keeps zero installed dependencies. Because nothing is installed
// locally, @eslint/js can't be imported; its recommended rules are listed here.

const recommendedRules = Object.fromEntries(
  [
    "constructor-super",
    "for-direction",
    "getter-return",
    "no-async-promise-executor",
    "no-case-declarations",
    "no-class-assign",
    "no-compare-neg-zero",
    "no-cond-assign",
    "no-const-assign",
    "no-constant-binary-expression",
    "no-constant-condition",
    "no-control-regex",
    "no-debugger",
    "no-delete-var",
    "no-dupe-args",
    "no-dupe-class-members",
    "no-dupe-else-if",
    "no-dupe-keys",
    "no-duplicate-case",
    "no-empty",
    "no-empty-character-class",
    "no-empty-pattern",
    "no-empty-static-block",
    "no-ex-assign",
    "no-extra-boolean-cast",
    "no-fallthrough",
    "no-func-assign",
    "no-global-assign",
    "no-import-assign",
    "no-invalid-regexp",
    "no-irregular-whitespace",
    "no-loss-of-precision",
    "no-misleading-character-class",
    "no-new-native-nonconstructor",
    "no-nonoctal-decimal-escape",
    "no-obj-calls",
    "no-octal",
    "no-prototype-builtins",
    "no-redeclare",
    "no-regex-spaces",
    "no-self-assign",
    "no-setter-return",
    "no-shadow-restricted-names",
    "no-sparse-arrays",
    "no-this-before-super",
    "no-unassigned-vars",
    "no-undef",
    "no-unexpected-multiline",
    "no-unreachable",
    "no-unsafe-finally",
    "no-unsafe-negation",
    "no-unsafe-optional-chaining",
    "no-unused-labels",
    "no-unused-private-class-members",
    "no-unused-vars",
    "no-useless-assignment",
    "no-useless-backreference",
    "no-useless-catch",
    "no-useless-escape",
    "no-with",
    "require-yield",
    "use-isnan",
    "valid-typeof"
  ].map((rule) => [rule, "error"])
);

const readonly = (names) => Object.fromEntries(names.map((name) => [name, "readonly"]));

// Available in both browsers and Node, so the shared modules may use them.
const sharedGlobals = readonly([
  "AbortController",
  "DOMException",
  "TextDecoder",
  "TextEncoder",
  "URL",
  "clearTimeout",
  "console",
  "performance",
  "setTimeout",
  "structuredClone"
]);
const browserGlobals = readonly([
  "Blob",
  "File",
  "MutationObserver",
  "document",
  "fetch",
  "requestAnimationFrame",
  "window"
]);
const nodeGlobals = readonly(["Buffer", "process"]);

export default [
  { ignores: ["node_modules/", "coverage/"] },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: sharedGlobals
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      ...recommendedRules,
      eqeqeq: "error",
      "no-var": "error",
      "prefer-const": "error"
    }
  },
  {
    files: ["public/**/*.js"],
    languageOptions: { globals: { ...sharedGlobals, ...browserGlobals } }
  },
  {
    files: ["src/server.js", "src/static-server.js", "eslint.config.js"],
    languageOptions: { globals: { ...sharedGlobals, ...nodeGlobals } }
  },
  {
    // Tests run in Node, but browser tests pass callbacks into the page.
    files: ["test/**/*.js"],
    languageOptions: { globals: { ...sharedGlobals, ...nodeGlobals, ...browserGlobals } }
  }
];
