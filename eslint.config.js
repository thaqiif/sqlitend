import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "scripts/**", "bin/**", "docs/**"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // apps/web: React + browser. rules-of-hooks is an error: it catches the "hook after early return"
  // bug class (React error #310).
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "react-refresh/only-export-components": ["error", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // apps/server + packages/shared: Bun/Node runtime.
  {
    files: ["apps/server/**/*.ts", "packages/shared/**/*.ts"],
    languageOptions: { globals: { ...globals.node, Bun: "readonly" } },
  },

  // Server code predates linting and is deliberately not mass-edited. These two rules are
  // off for it (existing hits: unused vars/params in cli.ts, routes.ts and two tests;
  // a control-char regex in cli.ts). Re-enable and fix incrementally.
  {
    files: ["apps/server/**/*.ts", "packages/shared/**/*.ts"],
    rules: { "@typescript-eslint/no-unused-vars": "off", "no-control-regex": "off" },
  },

  // Config files run in Node.
  {
    files: ["*.config.{js,ts}", "apps/*/*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
);
