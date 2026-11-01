import assert from "node:assert/strict";

/** Preserve the request state when Node24/Workerd stream callbacks lose ALS. */
export function patchRscTrailer(code: string): string {
  const original = `    if (trailer && rscStream) {`;
  if (code.includes("const requestState = RequestStorage.getStore().state;")) {
    assert.ok(
      code.includes("const usedSearch = requestState.usedSearch;"),
      "Unknown partially patched Rebask trailer",
    );
    return code;
  }
  assert.equal(
    code.split(original).length,
    2,
    "Rebask RSC trailer changed; review compatibility",
  );
  assert.equal(
    code.split("const usedSearch = getUsedSearch();").length,
    2,
    "Rebask search state loader changed",
  );
  return code
    .replace(
      original,
      `${original}\n        const requestState = RequestStorage.getStore().state;`,
    )
    .replace(
      "const usedSearch = getUsedSearch();",
      "const usedSearch = requestState.usedSearch;",
    );
}
