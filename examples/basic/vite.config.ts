import { defineConfig } from "vite";
import rsc from "@vitejs/plugin-rsc";
import react from "@vitejs/plugin-react";
import { rebask } from "@rebask/core/vite";
import { cloudflarePpr } from "@hipdev/rebask-cloudflare";

export default defineConfig({
  plugins: [rsc(), react(), rebask(), cloudflarePpr()],
});
