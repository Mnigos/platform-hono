# Implementation Plan

## Goal

Extract the Hono HTTP adapter used by `rigtch.fm` into a public npm package
that integrates cleanly with NestJS, Hono, oRPC, better-auth, and
`nestjs-better-auth`.

## 1. Package Foundation

- Confirm npm package name before first publish.
- Keep `@nestjs/common`, `@nestjs/core`, `hono`, and `@hono/node-server` as peer dependencies.
- Build ESM output to `dist`.
- Publish only `dist`, `README.md`, and `LICENSE`.
- Add package provenance before first release if npm token flow supports it.

## 2. Adapter Extraction

- Copy the current `HonoAdapter` implementation from `rigtch.fm`.
- Remove repo-specific imports and constants.
- Preserve the public constructor option shape.
- Keep body parser skip support for auth routes.
- Keep request size limits for upload-heavy routes.
- Keep raw body support for webhook/auth use cases.
- Keep CORS, static assets, close, listen, redirect, and header APIs compatible with NestJS.

## 3. Hono Response Bridge

- Add explicit helpers for Hono response integration instead of requiring callers to mutate `ctx.res` directly.
- Expose a small public Hono context contract with optional response state.
- Add helper for detecting adapter-owned Hono contexts.
- Add helper for finalizing a Fetch `Response` through Hono-native APIs.
- Document how oRPC should use these helpers.

## 4. oRPC Compatibility

- Test `@orpc/nest` handlers with the adapter.
- Cover route matching, params, query strings, body parsing, response headers, and errors.
- Make sure the package resolves the review issue in `middleapi/orpc#1299`: oRPC should not set `res` directly.
- Prefer a package-level response helper that oRPC can call.

## 5. better-auth Compatibility

- Test `better-auth` mounted under `/api/auth`.
- Verify skipped body parsing works for better-auth request handling.
- Verify cookies, redirects, headers, and OAuth callback behavior are preserved.
- Document the recommended Nest bootstrap setup.

## 6. nestjs-better-auth Compatibility

- Reproduce the current `rigtch.fm` patched usage.
- Identify what the patch expects from request, response, headers, cookies, and body.
- Add integration tests for decorator/guard/session flows.
- Add package APIs only if they remove the need for app-level patches.

## 7. Unit Tests

- Route registration for `all`, `get`, `post`, `put`, `delete`, `patch`, `options`, and `use`.
- Request metadata normalization: `params`, `query`, `headers`, `ip`, and `baseUrl`.
- JSON, text, form, multipart, raw body, and skipped parser behavior.
- Reply behavior for JSON, text, buffers, empty bodies, errors, and prebuilt responses.
- Header get/set/append behavior.
- Redirect behavior.
- Not found and error handlers.
- Static asset registration.
- Request size limits via `content-length` and parsed body size.

## 8. Integration Tests

- Boot a minimal NestJS app with `HonoAdapter`.
- Hit real HTTP routes through the Hono node server.
- Test controller route matching and params.
- Test oRPC route handling.
- Test better-auth route handling.
- Test `nestjs-better-auth` request/session handling.
- Test request limit failures and malformed body behavior.
- Test custom exception filter response behavior.

## 9. Security Review

- Enforce body limits before parsing when `content-length` is available.
- Enforce parsed body size after parsing when needed.
- Avoid trusting forwarded IP headers by default without documentation.
- Do not read env files or secrets in package code or tests.
- Ensure auth routes can bypass body parsing.
- Confirm malformed payloads cannot crash the process.
- Confirm response headers cannot be injected through unsafe values.

## 10. Performance Review

- Avoid parsing request bodies more than once.
- Avoid unnecessary request/response cloning.
- Avoid buffering streams except for explicit raw body use cases.
- Add basic benchmark scripts after functional tests are stable.
- Compare simple Nest+Hono route throughput against Nest+Express baseline.
- Compare oRPC route throughput through the Hono adapter.

## 11. Documentation

- Add installation docs.
- Add NestJS bootstrap example.
- Add CORS example.
- Add body parser skip example for better-auth.
- Add request size limit example.
- Add oRPC integration docs.
- Add `nestjs-better-auth` integration docs.
- Add compatibility matrix.
- Document unsupported Nest APIs, including versioning and views if still unsupported.

## 12. Release

- Add release workflow.
- Decide between Changesets and semantic-release.
- Add npm provenance if available.
- Publish first prerelease.
- Consume prerelease in `rigtch.fm`.

## 13. Update oRPC PR

- Update `middleapi/orpc#1299` to use this package's public Hono response bridge.
- Remove direct `ctx.res` assignment from the oRPC implementation.
- Add oRPC tests for Hono route matching and response handling.
- Update oRPC docs with the Hono + NestJS integration path.
- Reference this package as the supported Hono adapter integration.

## 14. Create PR for nestjs-better-auth

- Open an upstream PR against `nestjs-better-auth`.
- Replace any app-specific assumptions currently handled by the `rigtch.fm` patch.
- Add Hono adapter compatibility tests.
- Ensure session extraction, cookies, redirects, and headers work through this adapter.
- Document NestJS + Hono + better-auth setup.

## 15. rigtch.fm Migration

- Replace `@repo/platform-hono` with the published npm package.
- Remove `packages/platform-hono`.
- Remove workspace-specific config for `packages/platform-hono`.
- Remove patches that become unnecessary after oRPC and `nestjs-better-auth` updates.
- Run `bun run typecheck`, `bun run check:fix`, and `bun run test`.

