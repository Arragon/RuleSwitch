# Third-Party Notices

This document is a concise dependency and license inventory for RuleSwitch Phase A. It does not reproduce full license texts and is not a substitute for the license files distributed by each dependency.

## Direct Production / Shipped Runtime Dependencies

| Dependency | Version | License |
| --- | ---: | --- |
| Rulesync | 16.14.0 | MIT |
| Electron | 43.4.1 | MIT |
| React | 19.2.4 | MIT |
| React DOM | 19.2.4 | MIT |
| Zod | 4.2.1 | MIT |
| Monaco Editor | 0.52.2 | MIT |
| `@monaco-editor/react` | 4.7.0 | MIT |
| `react-markdown` | 10.1.0 | MIT |
| `remark-gfm` | 4.0.1 | MIT |
| `rehype-sanitize` | 6.0.0 | MIT |
| `write-file-atomic` | 7.0.0 | ISC |

The internal `@ruleswitch/*` workspace packages are part of this repository and are not third-party dependencies.

## Build Tooling (Not Shipped Runtime)

| Dependency | Version | License | Use |
| --- | ---: | --- | --- |
| esbuild | 0.27.7 | MIT | Bundles the Rulesync provider adapter's internal modules into one ESM entry; released 2026-04-02 |

esbuild is a provider/Vite build-time tool and is not classified as a shipped runtime dependency. Rulesync remains an external runtime dependency of `@ruleswitch/rulesync-provider`.

## Transitive Review

The lockfile is the authoritative record of resolved transitive versions. Generate the current production license inventory from the repository root with:

```text
corepack pnpm licenses list --prod
```

The reviewed transitive set is predominantly MIT, ISC, Apache, and BSD. The following non-default labels were reviewed as permissive exceptions:

- `argparse`: Python-2.0 license;
- `human-readable-ids`: license metadata labeled `Apache2`;
- `uri-templates`: public-domain license.

Before a release, regenerate the inventory from the frozen lockfile and review additions or license changes.

## Vulnerability Review

The current explicit public-registry production audit reported no known vulnerabilities:

```text
corepack pnpm audit --prod --registry=https://registry.npmjs.org
```

The default npmmirror audit endpoint is unavailable in the current environment. That endpoint failure is an environment limitation, not a clean audit result; use an explicitly available audit registry and retain its output for release review.

## Packaging Dependency Decision

`pnpm allowBuilds` explicitly retains only `electron`, `esbuild`, and `tldjs`. They are required respectively for Electron installation, Vite/provider builds, and Rulesync's transitive installation. This allowlist must not be expanded silently. `chokidar` is not currently a dependency and is deferred to Phase B watcher work.

`apps/desktop/electron-builder.yml` reserves NSIS, DMG/ZIP, AppImage, and deb targets, but electron-builder is not currently installed or enabled. The packaging phase must explicitly review and approve required lifecycle scripts, or choose another packaging approach. A reserved configuration file does not imply that distributables, signing, or packaging CI have been executed.
