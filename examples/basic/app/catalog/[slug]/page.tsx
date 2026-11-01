import { Suspense } from "react";
import { routeParams } from "@rebask/core/request";
import { cacheLife, cacheTag } from "@rebask/core/cache";
async function catalogItem(slug: string) {
  "use cache";
  cacheLife({ revalidate: 5, expire: 30 });
  cacheTag("catalog");
  return { slug, generated: Date.now() };
}
async function Item() {
  const { slug } = await routeParams<{ slug: string }>();
  const item = await catalogItem(slug);
  return (
    <section data-generated={item.generated}>
      <h2>{item.slug}</h2>
      <p>Public catalog snapshot: {item.generated}</p>
    </section>
  );
}
export default function Catalog() {
  return (
    <>
      <h1>Public catalog</h1>
      <Suspense fallback={<p>Loading public item…</p>}>
        <Item />
      </Suspense>
    </>
  );
}
