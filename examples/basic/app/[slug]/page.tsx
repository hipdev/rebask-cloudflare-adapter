import { Suspense } from "react";
import { routeParams, headers } from "@rebask/core/request";
async function Runtime() {
  const { slug } = await routeParams<{ slug: string }>();
  const requestHeaders = await headers();
  return (
    <section>
      <h2>Hello {slug}</h2>
      <p>
        Request marker: {requestHeaders.get("x-example-viewer") ?? "anonymous"}
      </p>
    </section>
  );
}
export default function Page() {
  return (
    <>
      <h1>Static page frame</h1>
      <Suspense fallback={<p>Loading request content…</p>}>
        <Runtime />
      </Suspense>
    </>
  );
}
