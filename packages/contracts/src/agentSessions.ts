import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex", "pi"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

export const CODEX_PROJECT_RENAME_DISABLED_MESSAGE =
  "Project renaming from T3 is temporarily disabled. Rename the project in Codex, then synchronize agent history.";

export const AgentSessionImportSource = Schema.Struct({
  fullHistory: Schema.optional(Schema.Boolean),
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  // A decimal string keeps file IDs above 2^53 (common on NTFS) exact. Older
  // records stored a number.
  inode: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  fullHistory: Schema.optional(Schema.Boolean),
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
});

export const AgentSessionSidebarOrder = Schema.Struct({
  projectIds: Schema.Array(ProjectId),
  threadIds: Schema.Array(ThreadId),
});

export const AgentSessionSyncResult = Schema.Struct({
  sidebarOrder: Schema.optional(AgentSessionSidebarOrder),
  membershipErrorCount: NonNegativeInt,
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  unlinkedProjectCount: NonNegativeInt,
  truncated: Schema.Boolean,
});

export const AgentSessionMoveInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  beforeThreadId: Schema.optionalKey(ThreadId),
});

export const AgentSessionOrganizeResult = Schema.Struct({
  ...AgentSessionSidebarOrder.fields,
  desktopRefreshRequired: Schema.optionalKey(Schema.Boolean),
  moveConfirmation: Schema.optionalKey(
    Schema.Struct({
      threadId: ThreadId,
      projectId: ProjectId,
      projectTitle: TrimmedNonEmptyString,
      sourcePaths: Schema.Array(TrimmedNonEmptyString),
    }),
  ),
});

export const AgentSessionOrganizeInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("move-thread"),
    threadId: ThreadId,
    projectId: ProjectId,
    beforeThreadId: Schema.optionalKey(ThreadId),
    confirmedSourcePaths: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  }),
  Schema.Struct({
    action: Schema.Literal("rename-project"),
    projectId: ProjectId,
    title: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("rename-thread"),
    threadId: ThreadId,
    title: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("reorder-projects"),
    providerInstanceId: Schema.optionalKey(ProviderInstanceId),
    projectIds: Schema.Array(ProjectId),
  }),
]);
export type AgentSessionOrganizeInput = typeof AgentSessionOrganizeInput.Type;
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ?? `Failed to scan agent sessions during ${this.operation}.`;
  }
}
