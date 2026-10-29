import 'dotenv/config';
import { resolve } from 'path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.spec.ts'],
    // .claude/ holds agent worktrees (full repo copies); their specs must not run as part of this checkout.
    exclude: [...configDefaults.exclude, '.claude/**'],
    fileParallelism: false,
    setupFiles: ['infra/testing/vitest.setup.ts'],
  },
  resolve: {
    // Relative to this config so each checkout (including worktrees) resolves its own sources.
    alias: {
      '@shared': resolve(__dirname, 'shared'),
      '@modules': resolve(__dirname, 'modules'),
      '@infra': resolve(__dirname, 'infra'),
    },
  },
});
