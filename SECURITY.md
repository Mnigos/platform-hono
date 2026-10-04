# Security Policy

Report security issues through [GitHub's private vulnerability reporting
form](https://github.com/Mnigos/platform-hono/security/advisories/new).

Do not open public issues for suspected vulnerabilities or include sensitive
details in public discussions.

## Adapter Defaults

- Request bodies are limited before parsing by default.
- Forwarded client IP headers are ignored unless `trustProxy` is explicitly
  enabled.
- Malformed request bodies are rejected instead of being silently converted to
  empty objects.

Treat host headers, forwarded headers, redirect targets, and static asset
options as trust-boundary inputs owned by the consuming application.
