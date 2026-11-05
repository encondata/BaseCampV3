/// <reference types="vite/client" />

// injected by vite.config.ts `define` from package.json's version
declare const __KIOSK_VERSION__: string;

// injected by vite.config.ts `define`: sha256 over the TypeScript label
// generator's sources (lib/webLabels/labelgenHash.ts)
declare const __LABELGEN_HASH__: string;
