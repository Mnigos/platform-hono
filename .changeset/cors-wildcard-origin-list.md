---
"@mnigos/platform-hono": patch
---

Security: a `'*'` entry inside a CORS `origin` array is now matched literally, like Express `cors`, instead of allowing every origin. Configs such as `origin: ['https://app.example', '*']` with `credentials: true` previously reflected any request origin; they now only allow the listed origins. Use `origin: '*'` or `origin: true` to allow every origin.
