import { defineConfig } from "vite";

// The Tauri window loads the built files from ../dist; `npm run ui` serves them for a browser preview with a mock feed.
export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", target: "es2022", emptyOutDir: true },
});
