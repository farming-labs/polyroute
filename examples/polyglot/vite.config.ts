import { polyroute } from "@farming-labs/polyroute";
import { defineConfig } from "vite";

export default defineConfig({
  // `app/api/relay/route.rs` calls this server's own routes.
  plugins: [polyroute({ outbound: { allow: ["127.0.0.1", "localhost"] } })],
  build: {
    ssr: "src/server.ts",
    outDir: "dist",
    target: "node22",
  },
});
