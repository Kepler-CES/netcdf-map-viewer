import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// h5wasm ships a .wasm asset; exclude it from dep pre-bundling so Vite
// serves the wasm file correctly in dev and build.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ["h5wasm"] },
  server: { fs: { strict: false } },
});
