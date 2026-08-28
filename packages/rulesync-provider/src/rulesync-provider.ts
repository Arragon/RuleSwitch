import type {
  Change,
  ChangeSet,
  ConfigProvider,
  EntityId,
  FileResource,
  FileResourceFormat,
  FileRevision,
  ProviderDetectionRequest,
  ProviderDetectionResult,
  ProviderPreviewRequest,
  ProviderStageRequest,
  ProviderValidationRequest,
  ProviderValidationResult,
  RevisionAggregate,
  StagedOutput
} from "@ruleswitch/core";
import { generate } from "rulesync";

import { RulesyncProviderError } from "./errors";
import type {
  RulesyncProviderInfrastructure,
  SafeFileEntry,
  SymlinkPolicy
} from "./infrastructure";

const SOURCE_DIRECTORY = ".rulesync";
const MARKDOWN_EXTENSION = ".md";

interface DetectionContext {
  readonly workspaceId: EntityId;
  readonly workspaceRootResourceId: EntityId;
  readonly sourceRootResourceId: EntityId;
  readonly authorizedSourceIds: Set<EntityId>;
  sourceResources: readonly FileResource[];
}

interface StagedRegistryEntry {
  readonly output: StagedOutput;
  readonly workspaceId: EntityId;
  readonly profileId: EntityId;
  readonly targetId: EntityId;
  readonly generatedByPath: ReadonlyMap<string, FileResource>;
  readonly workspaceByPath: ReadonlyMap<string, FileResource>;
}

export class RulesyncProvider implements ConfigProvider {
  readonly descriptor = {
    id: "rulesync",
    version: "16.14.0",
    targets: [
      {
        providerTarget: "codexcli",
        name: "Codex CLI",
        features: ["rules"]
      }
    ]
  } as const;

  private readonly detections = new Map<EntityId, DetectionContext>();
  private readonly stagedOutputs = new Map<EntityId, StagedRegistryEntry>();
  private readonly changeSets = new Map<EntityId, ChangeSet>();
  private readonly stagedChangeSetIds = new Map<EntityId, EntityId>();

  constructor(private readonly infrastructure: RulesyncProviderInfrastructure) {}

  async detect(request: ProviderDetectionRequest): Promise<ProviderDetectionResult> {
    const sourceRootResourceId = await this.infrastructure.registerDirectoryRoot({
      workspaceId: request.workspaceId,
      parentRootResourceId: request.rootResourceId,
      logicalPath: SOURCE_DIRECTORY
    });

    if (sourceRootResourceId === null) {
      this.detections.delete(request.workspaceId);
      return {
        detected: false,
        sourceRootResourceId: null,
        sourceResources: []
      };
    }

    const context: DetectionContext = {
      workspaceId: request.workspaceId,
      workspaceRootResourceId: request.rootResourceId,
      sourceRootResourceId,
      authorizedSourceIds: new Set<EntityId>(),
      sourceResources: []
    };
    const sourceResources = await this.synchronizeSourceResources(context);

    if (!sourceResources.some((resource) => resource.format === "markdown")) {
      this.detections.delete(request.workspaceId);
      return {
        detected: false,
        sourceRootResourceId: null,
        sourceResources: []
      };
    }

    this.detections.set(request.workspaceId, context);
    return {
      detected: true,
      sourceRootResourceId,
      sourceResources
    };
  }

  async validate(request: ProviderValidationRequest): Promise<ProviderValidationResult> {
    const context = this.detections.get(request.workspaceId);
    if (context === undefined) {
      return this.invalidValidation(
        "DETECTION_REQUIRED",
        "Rulesync sources must be detected before validation.",
        null
      );
    }

    try {
      const resources = await this.synchronizeSourceResources(context);
      const selected = resources.find((resource) => resource.id === request.sourceResourceId);
      const issues: Array<{
        code: string;
        message: string;
        resourceId: EntityId | null;
      }> = [];

      if (!context.authorizedSourceIds.has(request.sourceResourceId) || selected === undefined) {
        issues.push({
          code: "INVALID_SOURCE_RESOURCE",
          message: "The selected resource does not belong to the detected Rulesync source context.",
          resourceId: request.sourceResourceId
        });
      } else if (selected.format !== "markdown") {
        issues.push({
          code: "SOURCE_NOT_MARKDOWN",
          message: "The selected Rulesync source must be a Markdown file.",
          resourceId: request.sourceResourceId
        });
      }

      if (!resources.some((resource) => resource.format === "markdown")) {
        issues.push({
          code: "NO_MARKDOWN_SOURCE",
          message: "The .rulesync directory must contain at least one Markdown source file.",
          resourceId: null
        });
      }

      return {
        valid: issues.length === 0,
        issues,
        sourceRevision: await this.infrastructure.aggregateRevision(resources)
      };
    } catch {
      return this.invalidValidation(
        "UNSAFE_SOURCE_TREE",
        "The Rulesync source tree could not be safely refreshed.",
        request.sourceResourceId
      );
    }
  }

  async stage(request: ProviderStageRequest): Promise<StagedOutput> {
    const context = this.requireDetectionContext(request.workspaceId);
    const stagingRootResourceId = await this.infrastructure.createEmptyStagingRoot(
      request.workspaceId
    );

    const sourceBeforeResources = await this.synchronizeSourceResources(context);
    this.requireSelectedMarkdownSource(context, sourceBeforeResources, request.sourceResourceId);
    const sourceStateBefore = await this.infrastructure.aggregateRevision(sourceBeforeResources);

    const [workspaceRoot, stagingOutputRoot] = await Promise.all([
      this.infrastructure.resolveAuthorizedRootPath(
        request.workspaceId,
        context.workspaceRootResourceId
      ),
      this.infrastructure.resolveAuthorizedRootPath(request.workspaceId, stagingRootResourceId)
    ]);

    await generate({
      inputRoot: workspaceRoot,
      outputRoots: [stagingOutputRoot],
      targets: ["codexcli"],
      features: ["rules"],
      delete: false,
      silent: true
    });

    const sourceAfterResources = await this.synchronizeSourceResources(context);
    const sourceStateAfter = await this.infrastructure.aggregateRevision(sourceAfterResources);
    if (!sameRevision(sourceStateBefore, sourceStateAfter)) {
      throw new RulesyncProviderError(
        "SOURCE_STALE",
        "Rulesync sources changed while staging output was generated."
      );
    }

    const generatedEntries = await this.enumerateCheckedFiles(
      request.workspaceId,
      stagingRootResourceId,
      "reject"
    );
    const generatedResources: FileResource[] = [];
    const workspaceResources: FileResource[] = [];
    const generatedByPath = new Map<string, FileResource>();
    const workspaceByPath = new Map<string, FileResource>();

    for (const entry of generatedEntries) {
      const format = formatForLogicalPath(entry.logicalPath);
      const generated = await this.infrastructure.registerFileResource({
        workspaceId: request.workspaceId,
        rootResourceId: stagingRootResourceId,
        logicalPath: entry.logicalPath,
        origin: "generated",
        format,
        readonly: true,
        symlinkPolicy: "reject"
      });
      generatedResources.push(generated);
      generatedByPath.set(entry.logicalPath, generated);

      const current = await this.infrastructure.registerFileResourceIfExists({
        workspaceId: request.workspaceId,
        rootResourceId: context.workspaceRootResourceId,
        logicalPath: entry.logicalPath,
        origin: "workspace",
        format,
        readonly: true,
        symlinkPolicy: "reject"
      });
      if (current !== null) {
        workspaceResources.push(current);
        workspaceByPath.set(entry.logicalPath, current);
      }
    }

    const output: StagedOutput = {
      id: this.infrastructure.createOpaqueId("staged-output"),
      generatedResources,
      previewRevision: {
        sourceState: sourceStateAfter,
        targetState: await this.infrastructure.aggregateRevision(workspaceResources),
        generatedState: await this.infrastructure.aggregateRevision(generatedResources)
      }
    };
    this.stagedOutputs.set(output.id, {
      output,
      workspaceId: request.workspaceId,
      profileId: request.profileId,
      targetId: request.targetId,
      generatedByPath,
      workspaceByPath
    });
    return output;
  }

  async preview(request: ProviderPreviewRequest): Promise<ChangeSet> {
    const staged = this.stagedOutputs.get(request.stagedOutputId);
    if (staged === undefined) {
      throw new RulesyncProviderError(
        "STAGED_OUTPUT_NOT_FOUND",
        "The staged output is not available in this provider instance."
      );
    }
    if (
      staged.workspaceId !== request.workspaceId ||
      staged.profileId !== request.profileId ||
      staged.targetId !== request.targetId
    ) {
      throw new RulesyncProviderError(
        "REQUEST_CONTEXT_MISMATCH",
        "The preview request does not match the staged output context."
      );
    }

    const existingChangeSetId = this.stagedChangeSetIds.get(request.stagedOutputId);
    if (existingChangeSetId !== undefined) {
      const cached = this.changeSets.get(existingChangeSetId);
      if (cached !== undefined) {
        return cached;
      }
    }

    const changes: Change[] = [];
    for (const [logicalPath, generated] of sortedMapEntries(staged.generatedByPath)) {
      const current = staged.workspaceByPath.get(logicalPath) ?? null;
      changes.push({
        id: this.infrastructure.createOpaqueId("change"),
        targetId: request.targetId,
        logicalPath,
        kind:
          current === null
            ? "create"
            : sameFileRevision(current, generated)
              ? "unchanged"
              : "modify",
        before: current === null ? null : toFileRevision(current),
        after: toFileRevision(generated)
      });
    }

    const changeSet: ChangeSet = {
      id: this.infrastructure.createOpaqueId("change-set"),
      workspaceId: request.workspaceId,
      profileId: request.profileId,
      targetId: request.targetId,
      status: "ready",
      previewRevision: staged.output.previewRevision,
      changes,
      createdAt: this.infrastructure.nowIso()
    };
    this.changeSets.set(changeSet.id, changeSet);
    this.stagedChangeSetIds.set(request.stagedOutputId, changeSet.id);
    return changeSet;
  }

  getChangeSet(changeSetId: EntityId): ChangeSet | undefined {
    return this.changeSets.get(changeSetId);
  }

  private requireDetectionContext(workspaceId: EntityId): DetectionContext {
    const context = this.detections.get(workspaceId);
    if (context === undefined) {
      throw new RulesyncProviderError(
        "DETECTION_REQUIRED",
        "Rulesync sources must be detected before staging."
      );
    }
    return context;
  }

  private requireSelectedMarkdownSource(
    context: DetectionContext,
    resources: readonly FileResource[],
    sourceResourceId: EntityId
  ): void {
    const selected = resources.find((resource) => resource.id === sourceResourceId);
    if (
      !context.authorizedSourceIds.has(sourceResourceId) ||
      selected === undefined ||
      selected.format !== "markdown"
    ) {
      throw new RulesyncProviderError(
        "INVALID_SOURCE_RESOURCE",
        "The selected source must be Markdown in the detected Rulesync context."
      );
    }
  }

  private async synchronizeSourceResources(
    context: DetectionContext
  ): Promise<readonly FileResource[]> {
    const entries = await this.enumerateCheckedFiles(
      context.workspaceId,
      context.sourceRootResourceId,
      "allow-contained"
    );
    const resources: FileResource[] = [];

    for (const entry of entries) {
      const registered = await this.infrastructure.registerFileResource({
        workspaceId: context.workspaceId,
        rootResourceId: context.sourceRootResourceId,
        logicalPath: entry.logicalPath,
        origin: "source",
        format: formatForLogicalPath(entry.logicalPath),
        readonly: true,
        symlinkPolicy: "allow-contained"
      });
      const refreshed = await this.infrastructure.refreshFileResource(
        context.workspaceId,
        registered.id
      );
      resources.push(refreshed);
      context.authorizedSourceIds.add(refreshed.id);
    }

    context.sourceResources = resources;
    return resources;
  }

  private async enumerateCheckedFiles(
    workspaceId: EntityId,
    rootResourceId: EntityId,
    symlinkPolicy: SymlinkPolicy
  ): Promise<readonly SafeFileEntry[]> {
    const entries = [
      ...(await this.infrastructure.enumerateSafeFiles(
        workspaceId,
        rootResourceId,
        symlinkPolicy
      ))
    ];
    entries.sort((left, right) => compareStrings(left.logicalPath, right.logicalPath));

    const exactPaths = new Set<string>();
    const foldedPaths = new Set<string>();
    for (const entry of entries) {
      assertLogicalPath(entry.logicalPath);
      const folded = entry.logicalPath.toLowerCase();
      if (exactPaths.has(entry.logicalPath) || foldedPaths.has(folded)) {
        throw new RulesyncProviderError(
          "UNSAFE_LOGICAL_PATH",
          "The file tree contains duplicate or case-insensitively colliding logical paths."
        );
      }
      exactPaths.add(entry.logicalPath);
      foldedPaths.add(folded);
    }
    return entries;
  }

  private async invalidValidation(
    code: string,
    message: string,
    resourceId: EntityId | null
  ): Promise<ProviderValidationResult> {
    return {
      valid: false,
      issues: [{ code, message, resourceId }],
      sourceRevision: await this.infrastructure.aggregateRevision([])
    };
  }
}

function assertLogicalPath(logicalPath: string): void {
  const segments = logicalPath.split("/");
  if (
    logicalPath.length === 0 ||
    logicalPath.startsWith("/") ||
    logicalPath.includes("\\") ||
    /^[A-Za-z]:/.test(logicalPath) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new RulesyncProviderError(
      "UNSAFE_LOGICAL_PATH",
      "Infrastructure returned an invalid provider-neutral logical path."
    );
  }
}

function formatForLogicalPath(logicalPath: string): FileResourceFormat {
  const lowerPath = logicalPath.toLowerCase();
  if (lowerPath.endsWith(MARKDOWN_EXTENSION) || lowerPath.endsWith(".mdc")) {
    return "markdown";
  }
  if (lowerPath.endsWith(".json")) {
    return "json";
  }
  if (lowerPath.endsWith(".jsonc")) {
    return "jsonc";
  }
  if (lowerPath.endsWith(".yaml") || lowerPath.endsWith(".yml")) {
    return "yaml";
  }
  if (lowerPath.endsWith(".toml")) {
    return "toml";
  }
  if (lowerPath.endsWith(".txt")) {
    return "text";
  }
  return "unknown";
}

function sameRevision(left: RevisionAggregate, right: RevisionAggregate): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.serialization === right.serialization &&
    left.digest === right.digest
  );
}

function sameFileRevision(left: FileResource, right: FileResource): boolean {
  return left.byteLength === right.byteLength && left.hash.digest === right.hash.digest;
}

function toFileRevision(resource: FileResource): FileRevision {
  return {
    resourceId: resource.id,
    hash: resource.hash,
    byteLength: resource.byteLength
  };
}

function sortedMapEntries(
  resources: ReadonlyMap<string, FileResource>
): readonly (readonly [string, FileResource])[] {
  return [...resources.entries()].sort(([left], [right]) => compareStrings(left, right));
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
