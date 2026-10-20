import { describe, expect, it } from "vitest";

import {
  classifyProjectAvailability,
  evaluateProjectBinding,
  matchProjectsByRemote,
  type DirectoryProbe
} from "../project-binding";
import type { ProjectDefinition } from "../identity";

const DEMO: ProjectDefinition = {
  projectId: "prj_demo",
  displayName: "Demo",
  remoteMatch: ["git://github.com/acme/api", "git://github.com/acme/*"],
  createdAt: "1970-01-01T00:00:00.000Z"
};

const FORK: ProjectDefinition = {
  projectId: "prj_fork",
  displayName: "Fork",
  remoteMatch: ["git://github.com/other/api"],
  createdAt: "1970-01-01T00:00:00.000Z"
};

function gitProbe(url: string): DirectoryProbe {
  return { kind: "git-repo", canonicalRemote: url };
}

describe("project remote match (INH-1769)", () => {
  it("matches SSH and HTTPS clones of the same project remote", () => {
    const matches = matchProjectsByRemote([DEMO], "git://github.com/acme/api");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.projectId).toBe("prj_demo");
  });

  it("does not match a fork with a different remote", () => {
    expect(matchProjectsByRemote([DEMO], "git://github.com/other/api")).toHaveLength(0);
    expect(matchProjectsByRemote([FORK], "git://github.com/acme/api")).toHaveLength(0);
  });

  it("supports wildcard patterns", () => {
    expect(matchProjectsByRemote([DEMO], "git://github.com/acme/anything")).toHaveLength(1);
  });
});

describe("manual binding verification (INH-1769)", () => {
  it("accepts a directory whose remote matches the project", () => {
    const decision = evaluateProjectBinding({ definition: DEMO, probe: gitProbe("git://github.com/acme/api"), allowNoGit: false });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.verification).toBe("remote-match");
    }
  });

  it("refuses a same-remote fork directory for the wrong project", () => {
    const decision = evaluateProjectBinding({ definition: DEMO, probe: gitProbe("git://github.com/other/api"), allowNoGit: false });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("WRONG_PROJECT");
      expect(decision.message).toContain("other/api");
    }
  });

  it("requires explicit confirmation for non-Git directories and rejects unreadable ones", () => {
    const refused = evaluateProjectBinding({ definition: DEMO, probe: { kind: "not-a-repo" }, allowNoGit: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("GIT_REQUIRED");
    }
    const confirmed = evaluateProjectBinding({ definition: DEMO, probe: { kind: "not-a-repo" }, allowNoGit: true });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.verification).toBe("explicit-no-git");
    }
    const unreadable = evaluateProjectBinding({ definition: DEMO, probe: { kind: "unreadable" }, allowNoGit: true });
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) {
      expect(unreadable.code).toBe("DIRECTORY_UNREADABLE");
    }
  });

  it("classifies availability without ever deleting config", () => {
    expect(classifyProjectAvailability(true, true)).toBe("available");
    expect(classifyProjectAvailability(true, false)).toBe("moved");
    expect(classifyProjectAvailability(false, false)).toBe("missing");
  });
});
