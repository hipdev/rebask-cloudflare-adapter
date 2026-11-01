import type { RebaskConfig } from "@rebask/core";
import { createCacheHandler } from "@hipdev/rebask-cloudflare/cache";
export default { cacheHandler: createCacheHandler() } satisfies RebaskConfig;
