/** Bare packages the allowlisted portal modules import (directly or
 *  through their relative imports inside portal/src). Shared files resolve
 *  their own imports from portal/node_modules, so without dedupe the wiki
 *  would bundle a second React, router or gsap and every hook would break.
 *  vite.config.ts feeds this to `resolve.dedupe`; web/src/portalImports.test.ts
 *  fails when a portal module starts importing a package missing from it. */
export const dedupe: string[] = ['react', 'react-dom', 'react-router-dom', 'gsap', 'bwip-js'];
