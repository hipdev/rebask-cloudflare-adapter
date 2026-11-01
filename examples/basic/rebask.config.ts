import type { RebaskConfig } from "@rebask/core";
import { createCacheHandler } from "rebask-cloudflare-adapter/cache";
export default { cacheHandler: createCacheHandler() } satisfies RebaskConfig;
