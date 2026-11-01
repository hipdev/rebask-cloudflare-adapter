import { Suspense } from "react";
import { routeParams, headers } from "@rebask/core/request";
import { catalogItem } from "../../../lib/catalog";
async function Runtime() {
  const { slug } = await routeParams<{ slug: string }>();
  const requestHeaders = await headers();
  const item = await catalogItem(slug);
  return (
    <section data-generated={item.generated}>
      <p>
        {item.slug}: {item.generated}
      </p>
      <p>Viewer: {requestHeaders.get("x-example-viewer") ?? "anonymous"}</p>
    </section>
  );
}
export default function Page() {
  return (
    <>
      <h1>Shared public data, private continuation</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <Runtime />
      </Suspense>
    </>
  );
}
