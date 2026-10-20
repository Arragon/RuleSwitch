import { describe, expect, it } from "vitest";

import {
  createAssetKeyId,
  createHarnessInstanceId,
  createHarnessInstanceRef,
  createLocalOnlyRepositoryIdentity,
  createRemoteRepositoryIdentity,
  matchesRemote,
  normalizeAssetLogicalName,
  normalizeGitRemoteUrl,
  type AssetKey,
  type StableIdHasher
} from "../identity";

// Self-contained SHA-256 (FIPS 180-4). The frozen golden constants below
// were produced independently with node:crypto, so this implementation
// cross-checks both the algorithm and the identity serialization.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const;

function sha256Hex(input: string): string {
  const bytes = new TextEncoderLike(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const block = new Uint8Array(paddedLength);
  block.set(bytes.data);
  block[bytes.length] = 0x80;
  const view = new DataView(block.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32));

  const h: [number, number, number, number, number, number, number, number] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const w = new Uint32Array(64);

  const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15]!, 7) ^ rotr(w[index - 15]!, 18) ^ (w[index - 15]! >>> 3);
      const s1 = rotr(w[index - 2]!, 17) ^ rotr(w[index - 2]!, 19) ^ (w[index - 2]! >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA256_K[index]! + w[index]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }

  return h.map((word) => word.toString(16).padStart(8, "0")).join("");
}

class TextEncoderLike {
  readonly data: Uint8Array;
  readonly length: number;
  constructor(input: string) {
    const codePoints = Array.from(input, (char) => char.codePointAt(0)!);
    const octets: number[] = [];
    for (const codePoint of codePoints) {
      if (codePoint < 0x80) {
        octets.push(codePoint);
      } else if (codePoint < 0x800) {
        octets.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
      } else if (codePoint < 0x10000) {
        octets.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
      } else {
        octets.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f)
        );
      }
    }
    this.data = Uint8Array.from(octets);
    this.length = this.data.length;
  }
}

const goldenHasher: StableIdHasher = { sha256Hex };

describe("canonical Git remote normalization (INH-1753)", () => {
  it("maps SSH and HTTPS forms of the same repository to one canonical remote", () => {
    const forms = [
      "git@github.com:acme/config.git",
      "https://github.com/acme/config.git",
      "https://github.com/acme/config",
      "ssh://git@github.com:22/acme/config.git",
      "git://github.com/acme/config",
      "https://user:token@github.com/acme/config.git"
    ];
    const canonical = forms.map((form) => normalizeGitRemoteUrl(form));
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe("git://github.com/acme/config");
  });

  it("lowercases the host but preserves path case", () => {
    expect(normalizeGitRemoteUrl("https://GitHub.Com/Acme/Config")).toBe("git://github.com/Acme/Config");
  });

  it("drops default ports and preserves custom ports", () => {
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.example.com:22/group/repo.git")).toBe(
      "git://gitlab.example.com/group/repo"
    );
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.example.com:2222/group/repo.git")).toBe(
      "git://gitlab.example.com:2222/group/repo"
    );
  });

  it("treats absolute local paths as local-only file remotes", () => {
    expect(normalizeGitRemoteUrl("/tmp/bare-remote.git/")).toBe("file:///tmp/bare-remote.git");
    expect(normalizeGitRemoteUrl("file:///tmp/bare-remote.git")).toBe("file:///tmp/bare-remote.git");
  });

  it("rejects malformed remotes", () => {
    expect(() => normalizeGitRemoteUrl("")).toThrow();
    expect(() => normalizeGitRemoteUrl("not a remote")).toThrow();
    expect(() => normalizeGitRemoteUrl("ftp://example.com/repo")).toThrow();
    expect(() => normalizeGitRemoteUrl("https:///missing-host")).toThrow();
  });
});

describe("stable identity golden vectors (INH-1753)", () => {
  // Frozen digests: same logical input must always produce these values,
  // across restarts and machines. Do not update without a contract change.
  it("derives the repository identity from the canonical remote only", () => {
    const https = createRemoteRepositoryIdentity("https://github.com/acme/config.git", goldenHasher);
    const ssh = createRemoteRepositoryIdentity("git@github.com:acme/config", goldenHasher);
    expect(https.repositoryId).toBe("repo_f80ba2ec8e9be38851196514b9bb92903b3d51001e7fbcb7cf7896e479a5f3d0");
    expect(ssh.repositoryId).toBe(https.repositoryId);
    expect(ssh.canonicalRemote).toBe("git://github.com/acme/config");
    expect(ssh.portability).toBe("remote");
  });

  it("keeps a custom SSH port distinct from the default-port repository", () => {
    const identity = createRemoteRepositoryIdentity(
      "ssh://git@gitlab.example.com:2222/group/repo.git",
      goldenHasher
    );
    expect(identity.repositoryId).toBe("repo_8008aa6d52a5d91567663ee7147e540c47cc44d82ffc564726a4a5221eb378f0");
    expect(createRemoteRepositoryIdentity("ssh://git@gitlab.example.com/group/repo.git", goldenHasher).repositoryId)
      .not.toBe(identity.repositoryId);
  });

  it("distinguishes remotes that differ only by path case", () => {
    const identity = createRemoteRepositoryIdentity("https://github.com/Acme/Config", goldenHasher);
    expect(identity.repositoryId).toBe("repo_c0467984a78abb20185948d098422b4b1951a2a668804b4988329f91684f50b6");
    expect(identity.repositoryId).not.toBe(
      createRemoteRepositoryIdentity("https://github.com/acme/config", goldenHasher).repositoryId
    );
  });

  it("derives local-only identities from their local key, not a path", () => {
    const identity = createLocalOnlyRepositoryIdentity("local-machine-key-1", goldenHasher);
    expect(identity.repositoryId).toBe("repo_1e7b4c4a2b0ce3785f727b8547e56b783292a548b616efc4ca7d2eaa391ea140");
    expect(identity.portability).toBe("local-only");
  });

  it("derives asset keys from scope + kind + logical name", () => {
    const globalSkill: AssetKey = {
      scope: { kind: "global" },
      kind: "skills",
      logicalName: "python/README.md"
    };
    expect(createAssetKeyId(globalSkill, goldenHasher)).toBe(
      "asset_65e7f652b98b5117f254f4393a0edd308eaa1bf6699c846b5f46b621c595213b"
    );

    const projectInstructions: AssetKey = {
      scope: { kind: "project", projectId: "prj_demo" },
      kind: "instructions",
      logicalName: "AGENTS.md"
    };
    expect(createAssetKeyId(projectInstructions, goldenHasher)).toBe(
      "asset_f12db54b0e3f6e2f7ba41bdc34ce7162c339c22fc4094291208c40b43caf084c"
    );
  });

  it("derives harness instance identities from adapter + scope + binding", () => {
    expect(
      createHarnessInstanceId(createHarnessInstanceRef("claude-code", { kind: "global" }), goldenHasher)
    ).toBe("harn_14ced9501a3d6d631d6da9286f9ebabe05802b48cefb3254f491dc2b5c5a50d6");
    expect(
      createHarnessInstanceId(
        createHarnessInstanceRef("codex", { kind: "project", projectId: "prj_demo" }),
        goldenHasher
      )
    ).toBe("harn_e31b7482d38f264dbe0fd9aa9459af42ae6a6b95c2ef8c9260e8c068ea211782");
  });

  it("is deterministic across repeated computation (restart/path independence)", () => {
    const first = createAssetKeyId(
      { scope: { kind: "global" }, kind: "instructions", logicalName: "AGENTS.md" },
      goldenHasher
    );
    const second = createAssetKeyId(
      { scope: { kind: "global" }, kind: "instructions", logicalName: "AGENTS.md" },
      goldenHasher
    );
    expect(first).toBe(second);
  });
});

describe("asset logical name normalization", () => {
  it("NFC-normalizes Unicode logical names to one identity", () => {
    const decomposed = "emo\u0301ji/README.md";
    const composed = "em\u00f3ji/README.md";
    expect(normalizeAssetLogicalName(decomposed)).toBe(composed);
    expect(
      createAssetKeyId({ scope: { kind: "global" }, kind: "skills", logicalName: decomposed }, goldenHasher)
    ).toBe(
      createAssetKeyId({ scope: { kind: "global" }, kind: "skills", logicalName: composed }, goldenHasher)
    );
  });

  it("rejects absolute, parent-traversing, and backslash names", () => {
    expect(() => normalizeAssetLogicalName("/etc/passwd")).toThrow();
    expect(() => normalizeAssetLogicalName("../escape")).toThrow();
    expect(() => normalizeAssetLogicalName("a\\b.md")).toThrow();
    expect(() => normalizeAssetLogicalName("a//b.md")).toThrow();
    expect(() => normalizeAssetLogicalName("")).toThrow();
  });

  it("keeps differently-cased logical names distinct", () => {
    const lower = createAssetKeyId(
      { scope: { kind: "global" }, kind: "skills", logicalName: "readme.md" },
      goldenHasher
    );
    const upper = createAssetKeyId(
      { scope: { kind: "global" }, kind: "skills", logicalName: "README.md" },
      goldenHasher
    );
    expect(lower).not.toBe(upper);
  });
});

describe("project remote match", () => {
  it("matches SSH and HTTPS remotes of the same project repository", () => {
    expect(matchesRemote("git://github.com/acme/*", "git://github.com/acme/api")).toBe(true);
    expect(matchesRemote("git://github.com/acme/*", "git://github.com/other/api")).toBe(false);
    expect(matchesRemote("git://github.com/acme/api", "git://github.com/acme/api")).toBe(true);
  });

  it("does not match when the path case differs", () => {
    expect(matchesRemote("git://github.com/acme/Api", "git://github.com/acme/api")).toBe(false);
  });
});
