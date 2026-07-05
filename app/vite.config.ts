import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// The Switchboard On-Demand SDK was built for node; it reaches for Buffer,
// process, and a few node builtins. Polyfill them for the browser bundle.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: { Buffer: true, process: true, global: true },
      protocolImports: true,
    }),
  ],
  define: { "process.env.ANCHOR_BROWSER": "true" },
});
