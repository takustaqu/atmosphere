import { defineConfig } from 'vitest/config';

export default defineConfig({
  // only this checkout's tests: not those of the worktrees kept under .claude
  test: { include: ['test/**/*.test.ts'] },
});
