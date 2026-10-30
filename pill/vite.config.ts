import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

// Relative base so the same bundle loads from a desktop window and from an extension page.
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: { port: 1431, strictPort: true, host: "127.0.0.1" },
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      // The notch and the full desktop app are two windows of one frontend
      // project. They share all state/components; only their entry shell differs.
      input: {
        pill: resolve(projectRoot, "index.html"),
        app: resolve(projectRoot, "app.html"),
      },
    },
  },
});
