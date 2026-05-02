# Repository Instructions

- Do not add explicit function or method return type annotations unless they are strictly needed, such as preserving a public contract, narrowing an inferred type, satisfying an override/interface requirement, or supporting recursive inference. Prefer letting TypeScript infer return types.
- Prefer interfaces over type aliases for object shapes.

## Release Workflow

- For release changes, create a changeset first, then run `changeset version` to bump `package.json`, update the changelog, and consume the pending changeset file.
- Do not recreate old consumed changeset files for past releases unless explicitly asked.
