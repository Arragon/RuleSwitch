# v1 Config Repo Golden Fixtures

Fixture family for M2+ parse/graph regression (INH-1773):

- `personal-minimal/` — minimal single-user repo (manifest + one global
  instruction + one profile). Expected: 1 asset, no projects.
- `full-matrix/` — multi-project + override chain: global kinds
  (instructions/skills/mcp/hooks), global native variant (codex), two
  projects (`prj_api` with instructions + project native claude-code
  variant, `prj_web` definition only), two profiles (`strict` replaces
  `instructions/AGENTS.md`), unmanaged `README.md`.
  Precedence expectations live in the regression test.
- `invalid/unknown-field/` — manifest must fail closed (SEMANTIC_UNKNOWN_FIELD).
- `invalid/case-collision/` — documents the case-collision scenario; on a
  case-insensitive APFS checkout the two files cannot coexist on disk, so
  the PATH_CASE_COLLISION regression runs from the in-memory source in
  `repo-layout.unit.test.ts` instead.

Rules for extending (M5/M6): new config kinds extend THIS family — add a
variant directory and update the regression matrix in
`tests/integration/repo-inventory.integration.test.ts`; never fork a
second fixture tree. Fixtures must not depend on the developer's HOME.
