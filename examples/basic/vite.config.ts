import { defineConfig } from "vite";
import rsc from "@vitejs/plugin-rsc";
import react from "@vitejs/plugin-react";
import { rebask } from "@rebask/core/vite";
import { cloudflareAdapter } from "rebask-cloudflare-adapter";

export default defineConfig({
  plugins: [
    rsc(),
    react(),
    rebask(),
    cloudflareAdapter({
      durableCache: true,
      draftMode: true,
      pageCache: { paths: ["/catalog/item-a"], maxAge: 60 },
      images: { localPrefixes: ["/images/"] },
    }),
  ],
});
