import { describe, expect, it } from "vitest";

import { buildCapturePlan, verifyCapturePlanFreshness } from "../capture";
import { aggregateSkillAssets, digestSkillFiles, fileChangeKind, inferExecutable, skillFileDeltas } from "../skill-asset";
import { testHasher } from "./test-hasher";
import { utf8Encode } from "../utf8";

function skill(files: Record<string, string>) {
  return {
    skillName: "demo",
    files: Object.entries(files).map(([relativePath, content]) => ({
      relativePath,
      content: utf8Encode(content),
      executable: inferExecutable(relativePath, utf8Encode(content))
    })),
    digest: ""
  };
}

function withDigest(input: { skillName: string; files: { relativePath: string; content: Uint8Array; executable: boolean }[] }) {
  return { ...input, digest: digestSkillFiles(input.files, testHasher) };
}

describe("skill directory asset semantics (INH-1774)", () => {
  it("aggregates file-level assets into directory skills deterministically", () => {
    const aggregated = aggregateSkillAssets(
      [
        { logicalName: "alpha/SKILL.md", content: utf8Encode("a") },
        { logicalName: "alpha/scripts/run.sh", content: utf8Encode("#!/bin/sh\n") },
        { logicalName: "beta/SKILL.md", content: utf8Encode("b") },
        { logicalName: "loose.md", content: utf8Encode("not a directory skill") }
      ],
      testHasher
    );
    expect(aggregated.map((entry) => entry.skillName)).toEqual(["alpha", "beta"]);
    expect(aggregated[0]?.files.map((file) => file.relativePath)).toEqual(["SKILL.md", "scripts/run.sh"]);
    // scripts/ files are executable by the frozen heuristic.
    expect(aggregated[0]?.files[1]?.executable).toBe(true);
    // Deterministic: same input twice → identical digest.
    expect(aggregated[0]?.digest).toBe(
      aggregateSkillAssets([{ logicalName: "alpha/SKILL.md", content: utf8Encode("a") }, { logicalName: "alpha/scripts/run.sh", content: utf8Encode("#!/bin/sh\n") }], testHasher)[0]?.digest
    );
  });

  it("localizes any managed file change to the same skill asset", () => {
    const before = withDigest(skill({ "SKILL.md": "v1", "assets/x.txt": "x", "scripts/run.sh": "#!/bin/sh\n" }));
    const afterNested = withDigest(skill({ "SKILL.md": "v1", "assets/x.txt": "changed", "scripts/run.sh": "#!/bin/sh\n" }));
    expect(fileChangeKind(before, afterNested)).toBe("modify");
    const deltas = skillFileDeltas(before, afterNested);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.relativePath).toBe("assets/x.txt");
    // Same digest when nothing changed.
    expect(fileChangeKind(before, before)).toBe("unchanged");
    expect(skillFileDeltas(before, before)).toHaveLength(0);
  });

  it("detects same-length content changes (byte comparison, not length)", () => {
    const before = withDigest(skill({ "a.txt": "aaaa" }));
    const after = withDigest(skill({ "a.txt": "bbbb" }));
    expect(fileChangeKind(before, after)).toBe("modify");
  });
});

describe("capture plan decisions (INH-1777)", () => {
  const baseline = withDigest(skill({ "SKILL.md": "v1", "refs/r.md": "r" }));
  const planIdentity = {
    baselineRevision: "abc123",
    repoRevision: "def456",
    converterId: "ruleswitch.skills",
    converterVersion: "1.0.0"
  };

  it("builds modify/create/delete plans only for LOCAL_CHANGED", () => {
    const modified = withDigest(skill({ "SKILL.md": "v2", "refs/r.md": "r", "new.sh": "#!/bin/sh\n" }));
    const decision = buildCapturePlan({ scope: { kind: "global" }, skillName: "demo", baseline, scanned: modified, planIdentity });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.plan.managedPathPrefix).toBe("global/skills/demo/");
      expect(decision.plan.writes.map((write) => write.logicalPath).sort()).toEqual([
        "global/skills/demo/SKILL.md",
        "global/skills/demo/new.sh"
      ]);
      expect(decision.plan.writes.find((write) => write.logicalPath.endsWith("new.sh"))?.executable).toBe(true);
    }

    const deletedFile = withDigest(skill({ "SKILL.md": "v1" }));
    const deletion = buildCapturePlan({ scope: { kind: "global" }, skillName: "demo", baseline, scanned: deletedFile, planIdentity });
    if (!deletion.ok) {
      throw new Error(deletion.message);
    }
    expect(deletion.plan.writes).toContainEqual(
      expect.objectContaining({ logicalPath: "global/skills/demo/refs/r.md", content: null })
    );

    const projectScoped = buildCapturePlan({
      scope: { kind: "project", projectId: "prj_demo" },
      skillName: "demo",
      baseline,
      scanned: modified,
      planIdentity
    });
    if (!projectScoped.ok) {
      throw new Error(projectScoped.message);
    }
    expect(projectScoped.plan.managedPathPrefix).toBe("projects/prj_demo/skills/demo/");
  });

  it("refuses clean targets and requires ownership for unknown baselines", () => {
    const clean = buildCapturePlan({ scope: { kind: "global" }, skillName: "demo", baseline, scanned: baseline, planIdentity });
    expect(clean.ok).toBe(false);
    if (!clean.ok) {
      expect(clean.code).toBe("NOT_LOCAL_CHANGED");
    }

    const unknown = buildCapturePlan({ scope: { kind: "global" }, skillName: "demo", baseline: null, scanned: baseline, planIdentity });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.code).toBe("OWNERSHIP_CONFIRMATION_REQUIRED");
    }
  });

  it("stale plans are refused when the target moved on", () => {
    const modified = withDigest(skill({ "SKILL.md": "v2", "refs/r.md": "r" }));
    const decision = buildCapturePlan({ scope: { kind: "global" }, skillName: "demo", baseline, scanned: modified, planIdentity });
    if (!decision.ok) {
      throw new Error(decision.message);
    }
    const stillFresh = verifyCapturePlanFreshness(decision.plan, modified, {
      repoRevision: planIdentity.repoRevision,
      converterId: planIdentity.converterId,
      converterVersion: planIdentity.converterVersion
    });
    expect(stillFresh.ok).toBe(true);
    const movedOn = withDigest(skill({ "SKILL.md": "v3", "refs/r.md": "r" }));
    const stale = verifyCapturePlanFreshness(decision.plan, movedOn);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe("STALE_PLAN");
    }
    // Identity drift (repo revision changed) also refuses the plan.
    const drifted = verifyCapturePlanFreshness(decision.plan, modified, {
      repoRevision: "moved-on",
      converterId: planIdentity.converterId,
      converterVersion: planIdentity.converterVersion
    });
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) {
      expect(drifted.code).toBe("STALE_PLAN");
    }
  });
});
