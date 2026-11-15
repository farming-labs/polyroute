import { polyroute } from "@farming-labs/polyroute";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [polyroute()],
  build: {
    ssr: "src/server.ts",
    outDir: "dist",
    target: "node22",
  },
});
