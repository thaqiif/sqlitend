import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In dev, the backend serves the API at 127.0.0.1:6100; proxy /api there.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:6100",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // esbuild mangles HeroUI's `:is()` selectors (css-syntax-error warnings); lightningcss does not.
    cssMinify: "lightningcss",
    cssTarget: "esnext",
  },
});
