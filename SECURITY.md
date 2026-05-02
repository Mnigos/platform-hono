# Security Policy

Report security issues privately to the repository owner.

Do not open public issues for suspected vulnerabilities.

## Adapter Defaults

- Request bodies are limited before parsing by default.
- Forwarded client IP headers are ignored unless `trustProxy` is explicitly
  enabled.
- Malformed request bodies are rejected instead of being silently converted to
  empty objects.

Treat host headers, forwarded headers, redirect targets, and static asset
options as trust-boundary inputs owned by the consuming application.
