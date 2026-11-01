import { cacheLife, cacheTag } from "@rebask/core/cache";
export async function catalogItem(slug: string) {
  "use cache";
  cacheLife({ revalidate: 5, expire: 30 });
  cacheTag("catalog");
  return { slug, generated: Date.now() };
}
