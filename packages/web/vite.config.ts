import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Resolve @solace/shared to its TypeScript SOURCE rather than its built dist.
      //
      // shared builds to CommonJS because the server needs it that way, and it is symlinked in
      // as a workspace package. Web only ever imported *types* from it, which erase at compile
      // time, so nothing noticed - until the first real value import (searchCatalog). Then the
      // production build failed ("not exported by shared/dist/index.js") because Rollup's
      // CommonJS transform only looks inside node_modules, and a build-only `commonjsOptions`
      // fix left DEV broken in a different way: Vite serves ESM and cannot read a named export
      // off a CJS file, so the whole app died on load with "does not provide an export named
      // 'searchCatalog'". Pointing at the source sidesteps both - Vite compiles the TS itself,
      // dev and build behave identically, and shared stays CommonJS for the server.
      "@solace/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4310",
      "/ws": { target: "ws://localhost:4310", ws: true },
    },
  },
});


