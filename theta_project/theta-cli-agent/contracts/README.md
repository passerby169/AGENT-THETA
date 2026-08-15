# THETA Agent API V3 contracts

This directory is the transport contract shared by the THETA Agent API and
its presentation clients. Phase 1 freezes the frontend-blocking surface only;
it does not implement the backend routes.

Contract rules:

- `theta-agent-api-v3.openapi.yaml` is the canonical HTTP contract.
- `examples/*.json` are executable fixtures for frontend mocks and future
  backend contract tests.
- `errors/error-codes.json` is the stable error registry.
- Existing fields cannot be renamed or reinterpreted within API major v3.
- Optional fields and new event types require matching examples.
- Breaking changes require a new API major version.

The frontend mirror lives in
`theta_project/theta-web-v2/lib/api/v3/contracts.generated.ts`. Until an
OpenAPI generator is added to CI, every contract change must update that file
and pass the frontend typecheck in the same change.
