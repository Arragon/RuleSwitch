// ProjectDefinition ↔ local directory binding rules (INH-1769, pure core
// logic). Cross-device project identity lives in the config repo; the
// absolute local path lives only in the local binding store. Rebinding is
// verified against the directory's real Git identity so a look-alike
// directory can never be silently bound to the wrong project.

import type { CanonicalRemote, ProjectDefinition } from "./identity";
import { matchesRemote } from "./identity";

export type DirectoryProbe =
  | { readonly kind: "git-repo"; readonly canonicalRemote: CanonicalRemote }
  | { readonly kind: "not-a-repo" }
  | { readonly kind: "unreadable" };

export interface ProjectRemoteMatch {
  readonly projectId: string;
  readonly matchedPattern: string;
}

/** Projects whose remoteMatch patterns accept the given canonical remote. */
export function matchProjectsByRemote(
  definitions: readonly ProjectDefinition[],
  canonicalRemote: CanonicalRemote
): readonly ProjectRemoteMatch[] {
  const matches: ProjectRemoteMatch[] = [];
  for (const definition of definitions) {
    const pattern = definition.remoteMatch.find((candidate) => matchesRemote(candidate, canonicalRemote));
    if (pattern !== undefined) {
      matches.push({ projectId: definition.projectId, matchedPattern: pattern });
    }
  }
  return matches;
}

export type BindingDecision =
  | { readonly ok: true; readonly verification: "remote-match" | "explicit-no-git" }
  | { readonly ok: false; readonly code: "WRONG_PROJECT" | "GIT_REQUIRED" | "DIRECTORY_UNREADABLE"; readonly message: string };

/**
 * Manual binding verification. Manual binding wins over remote matching,
 * but it must still prove the directory is THIS project:
 * - a Git directory must match one of the project's remoteMatch patterns
 *   (a fork with a different remote is refused);
 * - a non-Git directory binds only with an explicit no-git confirmation.
 */
export function evaluateProjectBinding(input: {
  readonly definition: ProjectDefinition;
  readonly probe: DirectoryProbe;
  readonly allowNoGit: boolean;
}): BindingDecision {
  if (input.probe.kind === "unreadable") {
    return { ok: false, code: "DIRECTORY_UNREADABLE", message: "target directory cannot be read" };
  }
  if (input.probe.kind === "git-repo") {
    const matched = matchProjectsByRemote([input.definition], input.probe.canonicalRemote);
    if (matched.length > 0) {
      return { ok: true, verification: "remote-match" };
    }
    return {
      ok: false,
      code: "WRONG_PROJECT",
      message: `directory remote ${input.probe.canonicalRemote} does not match project '${input.definition.projectId}'`
    };
  }
  if (input.allowNoGit) {
    return { ok: true, verification: "explicit-no-git" };
  }
  return {
    ok: false,
    code: "GIT_REQUIRED",
    message: "target directory is not a Git repository; confirm no-git binding explicitly if intended"
  };
}

export interface ProjectAvailability {
  readonly projectId: string;
  readonly status: "available" | "moved" | "missing";
}

/** Availability classification for a stored binding — never deletes config. */
export function classifyProjectAvailability(pathExists: boolean, canonicalRootMatches: boolean): ProjectAvailability["status"] {
  if (pathExists && canonicalRootMatches) {
    return "available";
  }
  return pathExists ? "moved" : "missing";
}
