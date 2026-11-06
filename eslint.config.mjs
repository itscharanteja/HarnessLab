import next from "@next/eslint-plugin-next";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/.next/**",
      "**/dist/**",
      "**/next-env.d.ts",
      "packages/schemas/generated/**",
      ".artifacts/**",
      ".venv/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["apps/web/**/*.{js,jsx,ts,tsx}"],
    plugins: { "@next/next": next },
    settings: { next: { rootDir: "apps/web/" } },
    rules: {
      ...next.configs["core-web-vitals"].rules,
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  prettier,
];
