# Maintainer release procedure

1. Update package.json and example dependency versions plus CHANGELOG.md. Commit the
   matching package-lock.json. Do not overwrite an already published version.
2. On Node24 run npm ci, npm test, npm run typecheck, npm run test:integration.
   Verify GitHub CI on Node24/26 and review npm pack --dry-run. Inspect the archive:
   only dist, public docs, README, license and package metadata should ship.
3. Use npm login --auth-type=web for the authorized hipdev account. Complete npm's
   required passkey/2FA check. Do not put a token into source or action logs.
4. Publish npm publish --access public. Complete any publish verification required
   by npm. Verify npm view @hipdev/rebask-cloudflare@VERSION and install that exact
   version in a clean consumer before declaring it available.
5. Tag vVERSION on the tested commit; create a GitHub release describing supported
   versions, tests and limits, linking the npm package. Confirm CI is green.

The repository includes CI, not an automatically authorized npm publisher. Future
OIDC publishing can be configured through npm trusted publishers for this exact
repository/workflow, with separately approved security-sensitive access. Until
then maintainers publish through npm's interactive authenticated flow.
