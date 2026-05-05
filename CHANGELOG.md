# @mnigos/platform-hono

## 0.1.4

### Patch Changes

- Restore request body compatibility for Nest guards and middleware while preserving the raw Hono request body for downstream consumers like oRPC.

## 0.1.3

### Patch Changes

- Support named wildcard route params from Nest route patterns.

## 0.1.2

### Patch Changes

- Allow Node 18-compatible Hono dependencies by supporting `@hono/node-server` 1.19.11 and newer with `hono` 4.10.7 and newer.

## 0.1.1

### Patch Changes

- Loosen peer dependency ranges to support compatible Hono and NestJS versions.

## 0.1.0

### Minor Changes

- 9001e41: Initial public release of the NestJS Hono HTTP adapter.

  This release includes:

  - `HonoAdapter` for booting NestJS applications on Hono.
  - Bun-first HTTP serving through `@hono/node-server`.
  - Nest-compatible route registration for common HTTP methods and middleware.
  - Request metadata normalization for params, query strings, headers, base URL,
    and trusted proxy IPs.
  - JSON, text, form, and multipart body parsing.
  - Raw body support for JSON and text requests.
  - Segment-aware body parser skips for auth and webhook routes.
  - Global and route-specific request size limits.
  - Nest-compatible response handling for JSON, text, buffers, empty responses,
    redirects, headers, custom errors, and not found handlers.
  - CORS and static asset support.
  - `NestHonoRequest` type for adapter-provided request fields such as `body`,
    `rawBody`, `params`, `query`, `headers`, `ip`, and `baseUrl`.
