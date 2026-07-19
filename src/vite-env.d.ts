/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Build stamp injected via vite `define` (see vite.config.ts).
declare const __APP_VERSION__: string
declare const __GIT_SHA__: string
declare const __BUILD_TIME__: string
