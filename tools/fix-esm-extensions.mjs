// Post-tsc fixup: rewrite extension-less relative ESM imports in dist to
// explicit .js extensions so Node's ESM loader (and Electron's) can resolve
// them. Only touches files inside packages/core/dist.
//
// Bundler-resolution tsc output uses "./x" for "./x.ts" sources; Node ESM
// requires "./x.js". This script maps each relative specifier to the
// matching file on disk (x.js, x/index.js) and rewrites the specifier.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DIST = path.resolve(import.meta.dirname, "..", "packages", "core", "dist");

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = path.resolve(path.dirname(fromFile), specifier);
  return [`${base}.js`, path.join(base, "index.js")];
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const files = await listFiles(DIST);
let rewritten = 0;
for (const file of files) {
  const source = await readFile(file, "utf8");
  const importPattern = /(from\s+|import\s*\(\s*)(["'])(\.[^"']+)\2/g;
  let updated = source;
  let changed = false;
  const matches = [...source.matchAll(importPattern)];
  for (const match of matches) {
    const [full, prefix, quote, specifier] = match;
    const candidates = resolveSpecifier(file, specifier);
    if (candidates === null) {
      continue;
    }
    for (const candidate of candidates) {
      if (await exists(candidate)) {
        // Rewrite to the resolved path relative to this file's directory,
        // keeping Node-compatible explicit extension.
        const resolvedSpecifier =
          "./" + path.relative(path.dirname(file), candidate).split(path.sep).join("/");
        const fixed = `${prefix}${quote}${resolvedSpecifier}${quote}`;
        if (fixed !== full) {
          updated = updated.split(full).join(fixed);
          changed = true;
        }
        break;
      }
    }
  }
  if (changed) {
    await writeFileSafe(file, updated);
    rewritten += 1;
  }
}
console.log(`fix-esm-extensions: rewrote ${rewritten} files in dist`);

async function writeFileSafe(file, content) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, content);
}
