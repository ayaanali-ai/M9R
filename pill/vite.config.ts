import { defineConfig } from "vite";

// Relative base so the same bundle loads from a desktop window and from an extension page.
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: { port: 1431, strictPort: true, host: "127.0.0.1" },
  build: { target: "chrome110", minify: "esbuild", sourcemap: false, emptyOutDir: true },
});
