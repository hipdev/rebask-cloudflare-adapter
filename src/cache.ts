import { resolve } from "node:path";
import { FilesystemCacheStorage } from "@rebask/core/cache";
import { artifacts } from "virtual:rebask-cloudflare/artifacts";
import { BuildArtifactStorage } from "./storage.js";

/** Use only in the Rebask config paired with cloudflarePpr(). */
export function createCacheHandler(root = process.cwd()) {
  return artifacts
    ? new BuildArtifactStorage(artifacts)
    : new FilesystemCacheStorage(resolve(root, "dist/.rebask/cache"));
}
