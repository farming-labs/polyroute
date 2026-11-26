import { defineConfig } from "@farm.js/core";
import { polyroute } from "@farming-labs/polyroute";

export default defineConfig({
  renderer: false,
  vite: { plugins: [polyroute()] },
});
