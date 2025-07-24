import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    exclude: ["mupdf"],
  },
  worker: {
    format: "es",
  },
});
