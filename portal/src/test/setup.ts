/**
 * Runs before every portal test file (vite.config.ts `test.setupFiles`).
 *
 * Testing Library's async queries (findBy…, waitFor) wait up to 3 s, not
 * the default 1 s: the full suite runs files in parallel, and on a loaded
 * machine a plan tab's first renders took longer than 1 s, so tests that
 * passed alone failed in the suite. Files in the node environment (no DOM)
 * don't load Testing Library at all.
 */
if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/react');
  configure({ asyncUtilTimeout: 3000 });
}

export {};
