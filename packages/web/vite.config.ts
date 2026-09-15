import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // @solace/shared builds to CommonJS (the server needs it that way) and is symlinked in as
    // a workspace package, so Rollup's CommonJS transform skips it by default - it only looks
    // inside node_modules. Until now web only imported *types* from shared, which erase, so
    // nothing noticed; the first real value import (searchCatalog) fails the build with
    // "not exported by ../shared/dist/index.js" without this.
    commonjsOptions: { include: [/shared[\\/]dist/, /node_modules/] },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4310",
      "/ws": { target: "ws://localhost:4310", ws: true },
    },
  },
});
