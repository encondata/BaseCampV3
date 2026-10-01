/** Bare packages the allowlisted portal modules import. Shared files
 *  resolve their own imports from portal/node_modules unless deduped, and
 *  a second React/router/gsap breaks every hook. portalImports.test.ts
 *  fails when a portal module starts importing a package missing here. */
export const dedupe: string[] = ['react', 'react-dom', 'react-router-dom', 'gsap', 'bwip-js'];
