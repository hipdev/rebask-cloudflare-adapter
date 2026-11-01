import { defineConfig } from "vite";
import rsc from "@vitejs/plugin-rsc";
import react from "@vitejs/plugin-react";
import { rebask } from "@rebask/core/vite";
import { cloudflarePpr } from "rebask-cloudflare-adapter";

export default defineConfig({
  plugins: [rsc(), react(), rebask(), cloudflarePpr({ durableCache: true })],
});
