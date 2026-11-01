# Contributing

Use Node24+ and npm ci. Read AGENTS.md and docs/architecture.md. For a change, run
npm test, npm run typecheck and npm run test:integration; include the behavior,
supported versions, evidence and remaining limits in your PR.

Keep examples runnable without private services or credentials. Include meaningful
regressions for cache isolation, request state and early delivery when changing
those behaviors. Changes to Rebask internal transforms must be tested against the
actual pinned source and a packed consumer on Node24. Do not widen peer ranges
without testing the claimed versions. Contributions are under the MIT license.
