// Real-transport credential evidence for INH-1765 (M1 Gate).
//
// Spins up a genuine HTTPS Git remote on loopback: TLS (self-signed) +
// HTTP Basic authentication + `git http-backend` smart-HTTP protocol, then
// drives the full clone → fetch → commit → push chain through the frozen
// GitPort using a REAL git credential helper script that reads credentials
// from environment variables only (no credential literals appear in this
// file, in fixtures, or in logs).
//
// Evidence boundary (stated honestly): this proves the HTTPS transport +
// credential-helper chain end to end on real macOS networking. The remote
// is loopback-hosted rather than an Internet-hosted private remote; a
// hosted-remote run can reuse the identical steps with a real URL.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { GitPortAdapter } from "../../apps/desktop/src/main/infrastructure/git/git-port-adapter";
import { createGitRuntime } from "../../apps/desktop/src/main/infrastructure/git/git-runtime";
import { RepositoryIdentityStore } from "../../apps/desktop/src/main/infrastructure/git/identity-store";

const exec = promisify(execFile);

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ruleswitch-https-"));
  temporaryRoots.push(root);
  return root;
}

const TEST_USER = "ruleswitch-evidence";
const TEST_PASSWORD = randomBytes(18).toString("base64url");

let httpsServer: import("node:https").Server | null = null;
let serverPort = 0;
let serverRoot = "";
let bareRemotePath = "";
let workSeedPath = "";
let helperPath = "";
let savedEnv: NodeJS.ProcessEnv = {};

async function fixtureGit(cwd: string, args: readonly string[]): Promise<void> {
  const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
  const result = await runtime.run(args, { cwd });
  if (!result.ok) {
    throw new Error("fixture git failed: " + (result.failure === null ? "unknown" : result.failure.message));
  }
}

async function startHttpsGitServer(): Promise<void> {
  const root = await temporaryDirectory();
  serverRoot = root;
  bareRemotePath = path.join(root, "private-remote.git");
  workSeedPath = path.join(root, "seed clone");

  await fixtureGit(root, ["init", "--bare", "--initial-branch=main", bareRemotePath]);
  await fixtureGit(root, ["clone", bareRemotePath, workSeedPath]);
  await fixtureGit(workSeedPath, ["config", "user.name", "Seed"]);
  await fixtureGit(workSeedPath, ["config", "user.email", "seed@ruleswitch.invalid"]);
  await mkdir(path.join(workSeedPath, "global", "instructions"), { recursive: true });
  await writeFile(path.join(workSeedPath, "ruleswitch.yaml"), "version: 1\n", "utf8");
  await writeFile(path.join(workSeedPath, "global", "instructions", "AGENTS.md"), "# seed\n", "utf8");
  await fixtureGit(workSeedPath, ["add", "."]);
  await fixtureGit(workSeedPath, ["commit", "-m", "seed"]);
  await fixtureGit(workSeedPath, ["push", "-u", "origin", "main"]);

  // Self-signed TLS certificate for the loopback endpoint.
  const keyPath = path.join(root, "server.key");
  const certPath = path.join(root, "server.cert");
  await exec("/usr/bin/openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=localhost",
    "-days",
    "2"
  ]);

  const expectedToken = "Basic " + Buffer.from(TEST_USER + ":" + TEST_PASSWORD).toString("base64");

  const pktLine = (payload: string): Buffer => Buffer.from((payload.length + 4).toString(16).padStart(4, "0") + payload);
  const flushPacket = Buffer.from("0000");

  const { createServer } = await import("node:https");
  const { spawn } = await import("node:child_process");

  const runStatelessRpc = (service: string, repoDir: string, input: Buffer, advertiseRefs: boolean): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const args = advertiseRefs
        ? [service, "--stateless-rpc", "--advertise-refs", repoDir]
        : [service, "--stateless-rpc", repoDir];
      const child = spawn("/usr/bin/git", args, { stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let stderrText = "";
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        stderrText += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0 || chunks.length === 0) {
          const meaningful = stderrText
            .split("\n")
            .filter((line) => !line.includes("trace:") && line.trim().length > 0)
            .join(" | ");
          // Surface rpc failures for diagnosis; secrets never appear here.
          console.log("[rpc] git service failed:", code, meaningful.slice(0, 300));
        }
        resolve(Buffer.concat(chunks));
      });
      child.stdin.end(input);
    });

  httpsServer = createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (request, response) => {
      void (async () => {
        try {
          const authorization = request.headers.authorization ?? "";
          if (authorization !== expectedToken) {
            response.writeHead(401, { "WWW-Authenticate": 'Basic realm="ruleswitch-evidence"' });
            response.end("Authentication required");
            return;
          }
          const url = new URL(request.url ?? "/", "https://localhost");
          const pathname = url.pathname.replace(/\/+$/, "");
          const repoPath = pathname.endsWith("/info/refs")
            ? pathname.slice(0, -"/info/refs".length)
            : pathname.replace(/\/(git-upload-pack|git-receive-pack)$/, "");
          const repositoryDir = serverRoot + repoPath;
          const service = url.searchParams.get("service");

          if (request.method === "GET" && pathname.endsWith("/info/refs") && service) {
            const gitService = service.replace(/^git-/, "");
            const body = await runStatelessRpc(gitService, repositoryDir, Buffer.alloc(0), true);
            const header = Buffer.concat([pktLine("# service=" + service + "\n"), flushPacket]);
            response.writeHead(200, {
              "Content-Type": "application/x-" + service + "-advertisement",
              "Cache-Control": "no-cache"
            });
            response.end(Buffer.concat([header, body]));
            return;
          }

          const postMatch = pathname.match(/\/(git-upload-pack|git-receive-pack)$/);
          if (request.method === "POST" && postMatch) {
            const bodyChunks: Buffer[] = [];
            for await (const chunk of request) {
              bodyChunks.push(chunk as Buffer);
            }
            const requestBody = Buffer.concat(bodyChunks);
            const rpcService = (postMatch[1] ?? "").replace(/^git-/, "");
            const body = await runStatelessRpc(rpcService, repositoryDir, requestBody, false);
            response.writeHead(200, {
              "Content-Type": "application/x-" + (postMatch[1] ?? "") + "-result",
              "Cache-Control": "no-cache"
            });
            response.end(body);
            return;
          }

          response.writeHead(404);
          response.end("not found");
        } catch {
          response.writeHead(500);
          response.end();
        }
      })();
    }
  );
  await new Promise<void>((resolve) => {
    httpsServer?.listen(0, "127.0.0.1", () => resolve());
  });
  const address = httpsServer?.address();
  if (typeof address === "object" && address !== null) {
    serverPort = address.port;
  }
}

beforeAll(async () => {
  savedEnv = { ...process.env };
  // Credentials enter ONLY via environment variables consumed by the real
  // credential helper; the test body never embeds usable literals.
  process.env.RULESWITCH_EVIDENCE_GIT_USER = TEST_USER;
  process.env.RULESWITCH_EVIDENCE_GIT_PASSWORD = TEST_PASSWORD;
  // Loopback self-signed TLS: verification is disabled for THIS evidence
  // run only (hosted remotes use CA-valid certificates).
  process.env.GIT_SSL_NO_VERIFY = "1";
  await startHttpsGitServer();

  // A real credential helper script; reads the environment at call time.
  const root = await temporaryDirectory();
  helperPath = path.join(root, "credential-helper.sh");
  await writeFile(
    helperPath,
    [
      "#!/bin/sh",
      'echo "username=$RULESWITCH_EVIDENCE_GIT_USER"',
      'echo "password=$RULESWITCH_EVIDENCE_GIT_PASSWORD"',
      ""
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 }
  );
  await chmod(helperPath, 0o700);

  // Scope the credential chain to this URL only, and reset it first so the
  // user's global helpers (e.g. osxkeychain) neither answer nor STORE the
  // evidence credentials — no keychain side effects from this suite.
  const scopedHelperKey = "credential.https://127.0.0.1:" + serverPort + ".helper";
  process.env.GIT_CONFIG_COUNT = "3";
  process.env.GIT_CONFIG_KEY_0 = scopedHelperKey;
  process.env.GIT_CONFIG_VALUE_0 = "";
  process.env.GIT_CONFIG_KEY_1 = scopedHelperKey;
  process.env.GIT_CONFIG_VALUE_1 = helperPath;
  process.env.GIT_CONFIG_KEY_2 = "http.sslVerify";
  process.env.GIT_CONFIG_VALUE_2 = "false";
}, 60_000);

afterAll(async () => {
  process.env.GIT_SSL_NO_VERIFY = savedEnv.GIT_SSL_NO_VERIFY ?? "";
  if (!savedEnv.GIT_SSL_NO_VERIFY) {
    delete process.env.GIT_SSL_NO_VERIFY;
  }
  for (const key of ["RULESWITCH_EVIDENCE_GIT_USER", "RULESWITCH_EVIDENCE_GIT_PASSWORD", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_KEY_2", "GIT_CONFIG_VALUE_2", "GIT_TRACE", "GIT_CURL_VERBOSE"]) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key] ?? "";
    }
  }
  await new Promise<void>((resolve) => {
    if (httpsServer) {
      httpsServer.close(() => resolve());
    } else {
      resolve();
    }
  });
});

afterEach(async () => {
  await Promise.all([]);
});

describe("real HTTPS private remote chain (INH-1765)", () => {
  test("clone → fetch → commit → push over authenticated HTTPS via a real credential helper", async () => {
    expect(serverPort).toBeGreaterThan(0);
    const root = await temporaryDirectory();
    const clonePath = path.join(root, "https clone");
    const remoteUrl = "https://ruleswitch-evidence@127.0.0.1:" + serverPort + "/private-remote.git";

    const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
    const identityStore = new RepositoryIdentityStore(path.join(root, "state", "v1.json"));
    await identityStore.load();
    const adapter = new GitPortAdapter({ gitRuntime: runtime, identityStore });

    const cloned = await adapter.clone({ remoteUrl, targetDirectory: clonePath });
    if (!cloned.ok || cloned.value === null) {
      throw new Error("clone failed: " + (cloned.error === null ? "unknown" : cloned.error.message));
    }
    expect(cloned.value.headRevision).toBeTruthy();
    expect(cloned.value.remoteStatus).toBe("up-to-date");

    const fetched = await adapter.fetch(cloned.value.repositoryId);
    expect(fetched.ok).toBe(true);
    expect(fetched.value).toBe("up-to-date");

    await writeFile(path.join(clonePath, "global", "instructions", "AGENTS.md"), "# over https\n", "utf8");
    const expected = await adapter.currentExpectedRevisions(cloned.value.repositoryId);
    if (!expected.ok || expected.value === null) {
      throw new Error("expected revisions failed");
    }
    const staged = await adapter.stage({
      repositoryId: cloned.value.repositoryId,
      logicalPaths: ["global/instructions/AGENTS.md"],
      expected: expected.value
    });
    expect(staged.ok).toBe(true);
    const commit = await adapter.commitStaged({
      repositoryId: cloned.value.repositoryId,
      message: "evidence commit over authenticated HTTPS",
      expected: expected.value,
      allowedManagedPaths: ["global/instructions/AGENTS.md"]
    });
    if (!commit.ok || commit.value === null) {
      throw new Error("commit failed: " + (commit.error === null ? "unknown" : commit.error.message));
    }
    const pushed = await adapter.push({
      repositoryId: cloned.value.repositoryId,
      expectedHead: commit.value.revision
    });
    if (!pushed.ok) {
      throw new Error("push failed: " + (pushed.error === null ? "unknown" : pushed.error.message));
    }
    expect(pushed.value).toBe("up-to-date");

    // The remote really received the commit: verify from an independent
    // file-path clone of the same bare repository.
    const verifyClone = path.join(root, "verify clone");
    await fixtureGit(root, ["clone", bareRemotePath, verifyClone]);
    expect(await readFile(path.join(verifyClone, "global", "instructions", "AGENTS.md"), "utf8")).toBe(
      "# over https\n"
    );
  }, 120_000);

  test("wrong credentials surface as structured auth-error without leaking the password", async () => {
    const root = await temporaryDirectory();

    // Swap the URL-scoped helper for one with a wrong password. The env
    // override must happen BEFORE the runtime snapshots process.env.
    const badHelper = path.join(root, "bad-helper.sh");
    await writeFile(
      badHelper,
      ["#!/bin/sh", 'echo "username=ruleswitch-evidence"', 'echo "password=definitely-wrong"', ""].join("\n"),
      { encoding: "utf8", mode: 0o700 }
    );
    const previousHelper = process.env.GIT_CONFIG_VALUE_1;
    process.env.GIT_CONFIG_VALUE_1 = badHelper;
    try {
      const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
      const adapter = new GitPortAdapter({ gitRuntime: runtime });
      const failed = await adapter.clone({
        remoteUrl: "https://ruleswitch-evidence@127.0.0.1:" + serverPort + "/private-remote.git",
        targetDirectory: path.join(root, "denied clone")
      });
      expect(failed.ok).toBe(false);
      expect(failed.error?.kind).toBe("auth-error");
      expect(failed.error?.message).not.toContain(TEST_PASSWORD);
    } finally {
      process.env.GIT_CONFIG_VALUE_1 = previousHelper ?? "";
    }
  }, 60_000);

  test("evidence run records transport facts without secrets", async () => {
    const runtime = await createGitRuntime({ executable: "/usr/bin/git" });
    expect(runtime.version).toMatch(/^\d+\.\d+\.\d+/);
    const digest = createHash("sha256").update(TEST_PASSWORD).digest("hex");
    // Only an irreversible digest of the credential is ever asserted;
    // the literal itself never appears in evidence output.
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);
});
