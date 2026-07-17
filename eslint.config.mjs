import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "next-env.d.ts",
    // Python virtualenvs (e.g. backtest/.venv) ship vendored, multi-megabyte
    // minified JS bundles (plotly, jupyter widgets). They are not our source,
    // and parsing them exhausts ESLint's heap (OOM / exit 134). tsc never sees
    // them because they're outside tsconfig's include — only ESLint crawls cwd.
    "**/.venv/**",
    "**/__pycache__/**",
    // Box scripts (deploy/box/**) are NOT app source: they are plain CommonJS
    // run by `node` INSIDE the prod container / by cron on the AWS box, against
    // the container's own node_modules (see docs/aws-deployment/). They must use
    // require() and have no bundler/tsconfig — linting them with the Next+TS
    // rules is a category error.
    "deploy/box/**",
  ]),
]);

export default eslintConfig;
