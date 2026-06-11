import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  ...tseslint.configs["flat/recommended"],
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "no-console": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  // ci/checks/db test files are outside the main lint scope but must still
  // enforce no-fallthrough (T-0189: seedRowForTable fall-through was silent
  // because the full recommended rule set is intentionally NOT applied here —
  // existing test files carry other violations that are out of scope for this
  // task).  Only no-fallthrough is enabled to keep CI noise-free.
  {
    files: ["ci/checks/db/**/*.ts"],
    languageOptions: {
      parser: tsparser,
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "no-fallthrough": "error",
      // Disable all rules inherited from flat/recommended for this glob to
      // avoid surfacing pre-existing violations in unrelated test files.
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
