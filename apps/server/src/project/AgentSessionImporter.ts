// @effect-diagnostics nodeBuiltinImport:off - derives import IDs and event revisions synchronously.
import * as NodeCrypto from "node:crypto";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  CommandId,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { synchronizeCodexHistory } from "./CodexHistory.ts";
import {
  synchronizeCodexMembership,
  moveCodexMembership,
  unassignedCodexProject,
  organizeCodex,
} from "./CodexProjectMembership.ts";
import type { AgentSessionOrganizeInput } from "@t3tools/contracts";

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeImportedTranscriptPayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.optional(Schema.String),
    importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
  }),
);

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly key?: string;
  readonly message: AgentSessionScanner.AgentSessionThreadMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix =
    input.key ??
    (input.message.nativeId
      ? `native:${input.message.nativeId}`
      : String(input.index).padStart(6, "0"));
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: input.message.nativeId
      ? {
          driver: ProviderDriverKind.make("codex"),
          nativeId: input.message.nativeId,
          strength: "strong" as const,
        }
      : null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

const make = Effect.gen(function* () {
  const syncLock = yield* Semaphore.make(1);
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
    refreshDiscovery: boolean = true,
    supplied?: ReadonlyArray<AgentSessionScanner.AgentSessionRecentThread>,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const completedSources = runtimeRows.flatMap((runtime) => {
      const payload = decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
    const outcomes = supplied
      ? Stream.fromIterable(supplied)
      : scanner.recentThreads(project.workspaceRoot, completedSources, {
          fullHistory: input.fullHistory === true,
          refreshDiscovery,
        });
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          const driver = ProviderDriverKind.make(thread.source);
          // Pi resumes by session file path; its session UUID only names the thread.
          const nativeThreadId =
            thread.source === "pi" ? source.filePath : thread.providerSessionId;
          const persistRuntime = runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                thread.source === "claudeAgent"
                  ? { threadId, resume: thread.providerSessionId }
                  : { threadId: nativeThreadId },
              runtimePayload: { cwd: thread.originalWorkspaceRoot ?? project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          const existing = yield* Effect.option(
            orchestrator.getThreadRecords(threadId, ["messages", "turnItems"]),
          );
          if (Option.isSome(existing)) {
            if (existing.value.thread.projectId !== input.projectId) {
              return yield* new AgentSessionThreadProjectConflictError({
                threadId,
                expectedProjectId: input.projectId,
                actualProjectId: existing.value.thread.projectId,
              });
            }
            if (existing.value.thread.deletedAt !== null) return false;
            // Reuse imported message IDs and update their timeline ordinals. Legacy
            // imports contain a capped tail with positional IDs; appending alone
            // would collide with those ordinals when earlier history is restored.
            const fingerprint = (message: { role: string; text: string }) =>
              NodeCrypto.createHash("sha256")
                .update(JSON.stringify([message.role, message.text]))
                .digest("hex");
            const importedItems = new Map(
              existing.value.turnItems.flatMap((item) =>
                "messageId" in item && item.messageId ? [[item.messageId, item] as const] : [],
              ),
            );
            const stored = new Map<string, Array<OrchestrationV2TurnItem>>();
            for (const message of existing.value.messages) {
              const item = importedItems.get(message.id);
              if (!item) continue;
              const hash = fingerprint(message);
              const bucket = stored.get(hash) ?? [];
              bucket.push(item);
              stored.set(hash, bucket);
            }
            for (const bucket of stored.values()) bucket.sort((a, b) => a.ordinal - b.ordinal);
            const events: Array<OrchestrationV2DomainEvent> = [];
            if (
              thread.archived !== undefined &&
              thread.archived !== (existing.value.thread.archivedAt !== null)
            ) {
              const updatedAt = dateTime(thread.updatedAt);
              events.push({
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:archive:${NodeCrypto.randomUUID()}`),
                type: thread.archived ? "thread.archived" : "thread.unarchived",
                threadId,
                occurredAt: updatedAt,
                payload: {
                  ...existing.value.thread,
                  archivedAt: thread.archived ? updatedAt : null,
                  updatedAt,
                },
              });
            }
            const reorder = (
              item: OrchestrationV2TurnItem,
              ordinal: number,
              sourceMessage?: AgentSessionScanner.AgentSessionThreadMessage,
            ) => {
              if (!item.id.startsWith(`${IMPORT_EVENT_PREFIX}:turn-item:${threadId}:`)) return;
              const nativeItemRef = sourceMessage?.nativeId
                ? {
                    driver: ProviderDriverKind.make("codex"),
                    nativeId: sourceMessage.nativeId,
                    strength: "strong" as const,
                  }
                : item.nativeItemRef;
              const contentChanged =
                sourceMessage !== undefined && "text" in item && item.text !== sourceMessage.text;
              if (
                item.ordinal === ordinal &&
                nativeItemRef?.nativeId === item.nativeItemRef?.nativeId &&
                !contentChanged
              )
                return;
              const revision = NodeCrypto.randomUUID();
              events.push({
                id: EventId.make(`${item.id}:source:${revision}`),
                type: "turn-item.updated",
                threadId,
                occurredAt: dateTime(thread.updatedAt),
                payload: {
                  ...item,
                  ordinal,
                  nativeItemRef,
                  ...(sourceMessage && "text" in item ? { text: sourceMessage.text } : {}),
                },
              });
              if (contentChanged && "messageId" in item) {
                const message = existing.value.messages.find(
                  (entry) => entry.id === item.messageId,
                );
                if (message && sourceMessage)
                  events.push({
                    id: EventId.make(`${message.id}:source:${revision}`),
                    type: "message.updated",
                    threadId,
                    occurredAt: dateTime(thread.updatedAt),
                    payload: {
                      ...message,
                      text: sourceMessage.text,
                      updatedAt: dateTime(thread.updatedAt),
                    },
                  });
              }
            };
            const sourceCounts = new Map<string, number>();
            const usedItems = new Set<TurnItemId>();
            const bucketOffsets = new Map<string, number>();
            const nativeItems = new Map(
              existing.value.turnItems.flatMap((item) =>
                item.nativeItemRef ? [[item.nativeItemRef.nativeId, item] as const] : [],
              ),
            );
            thread.messages.forEach((message, index) => {
              const hash = fingerprint(message);
              const occurrence = (sourceCounts.get(hash) ?? 0) + 1;
              sourceCounts.set(hash, occurrence);
              const nativeItem =
                message.nativeId === undefined ? undefined : nativeItems.get(message.nativeId);
              const bucket = stored.get(hash) ?? [];
              let offset = bucketOffsets.get(hash) ?? 0;
              while (offset < bucket.length && usedItems.has(bucket[offset]!.id)) offset++;
              const item =
                nativeItem && !usedItems.has(nativeItem.id) ? nativeItem : bucket[offset];
              bucketOffsets.set(hash, offset);
              if (item) {
                usedItems.add(item.id);
                reorder(item, index + 1, message);
              } else
                events.push(
                  ...messageEvents({
                    threadId,
                    message,
                    index,
                    key: message.nativeId
                      ? `native:${message.nativeId}`
                      : `sync:${hash}:${occurrence}`,
                  }),
                );
            });
            // Keep T3-authored activity and unmatched source items in their order,
            // after the recovered source transcript rather than overwriting them.
            const unmatched = new Set(
              [...stored.values()]
                .flat()
                .filter((item) => !usedItems.has(item.id))
                .map((item) => item.id),
            );
            const remaining = existing.value.turnItems
              .filter(
                (item) =>
                  unmatched.has(item.id) &&
                  item.id.startsWith(`${IMPORT_EVENT_PREFIX}:turn-item:${threadId}:`),
              )
              .toSorted((a, b) => a.ordinal - b.ordinal);
            remaining.forEach((item, index) => reorder(item, thread.messages.length + index + 1));
            if (events.length > 0) yield* eventSink.write({ events, importedHistory: true });
            yield* persistRuntime;
            yield* runtimes.recordImportedTranscript({ threadId, source });
            return true;
          }

          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            providerInstanceId: thread.providerInstanceId,
            nativeThreadId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: thread.originalWorkspaceRoot ?? null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: thread.archived ? updatedAt : null,
            settledOverride: "settled",
            settledAt: updatedAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: nativeThreadId,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          const committed = yield* eventSink.write({
            importedHistory: true,
            unlessNativeThreadOwned: providerThread,
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          if (committed.length === 0) return null;
          yield* persistRuntime;
          yield* runtimes.recordImportedTranscript({ threadId, source });
          return true;
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported === true) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (imported === false) {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  const sync = Effect.gen(function* () {
    const scan = yield* scanner.scan;
    let importedCount = 0;
    let skippedCount = 0;
    let unlinkedProjectCount = 0;
    for (const candidate of scan.candidates) {
      // Codex history is paginated by the native API below, not by rollout files.
      if (candidate.sources.every((source) => source === "codex")) continue;
      let projectId = candidate.projectId;
      if (projectId === undefined) {
        const key = NodeCrypto.createHash("sha256")
          .update(normalizeProjectPathForComparison(candidate.path))
          .digest("hex");
        const created = yield* Effect.option(
          projects.bootstrap({
            commandId: CommandId.make(`agent-history-project:${key}`),
            projectId: ProjectId.make(`agent-history:${key}`),
            title: candidate.title,
            workspaceRoot: candidate.path,
          }),
        );
        if (Option.isNone(created)) {
          unlinkedProjectCount += 1;
          continue;
        }
        projectId = created.value.project.id;
      }
      const result = yield* importRecentAgentThreads(
        {
          projectId,
          expectedWorkspaceRoot: candidate.path,
          fullHistory: true,
        },
        false,
      ).pipe(Effect.orElseSucceed(() => ({ importedCount: 0, skippedCount: 1 })));
      importedCount += result.importedCount;
      skippedCount += result.skippedCount;
    }
    let membershipErrorCount = 0;
    const sidebarOrder = { projectIds: [] as ProjectId[], threadIds: [] as ThreadId[] };
    const instances = new Set(
      (yield* runtimes
        .list()
        .pipe(
          Effect.mapError(
            (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
          ),
        )).flatMap((runtime) =>
        runtime.adapterKey === "codex" && runtime.providerInstanceId !== null
          ? [runtime.providerInstanceId]
          : [],
      ),
    );
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
    );
    for (const [id, instance] of Object.entries(settings.providerInstances)) {
      if (instance.driver === "codex" && instance.enabled !== false)
        instances.add(ProviderInstanceId.make(id));
    }
    for (const instanceId of instances) {
      const history = yield* synchronizeCodexHistory(instanceId, (native, messages) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`import:${instanceId}:${native.id}`);
          const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
          let projectId = Option.isSome(existing) ? existing.value.thread.projectId : undefined;
          if (projectId === undefined) {
            projectId = (yield* unassignedCodexProject()).id;
          }
          const result = yield* importRecentAgentThreads({ projectId, fullHistory: true }, false, [
            {
              _tag: "Importable",
              source: {
                provider: "codex",
                providerInstanceId: instanceId,
                providerSessionId: native.id,
                filePath: `codex-api:${native.id}`,
                size: messages.length,
                mtimeMs: native.updatedAt * 1000,
                device: 0,
                inode: null,
                birthtimeMs: null,
                fullHistory: true,
              },
              thread: {
                source: "codex",
                originalWorkspaceRoot: native.cwd,
                archived: native.archived,
                providerInstanceId: instanceId,
                providerSessionId: native.id,
                title: native.name ?? (native.preview.slice(0, 120) || "Codex chat"),
                model: null,
                createdAt: DateTime.formatIso(DateTime.makeUnsafe(native.createdAt * 1000)),
                updatedAt: DateTime.formatIso(DateTime.makeUnsafe(native.updatedAt * 1000)),
                messages,
              },
            },
          ]);
          importedCount += result.importedCount;
          skippedCount += result.skippedCount;
        }),
      ).pipe(
        Effect.scoped,
        Effect.orElseSucceed(() => 1),
      );
      skippedCount += history;
      yield* synchronizeCodexMembership(instanceId).pipe(
        Effect.scoped,
        Effect.tap((result) =>
          Effect.sync(() => {
            sidebarOrder.projectIds.push(...result.projectIds);
            sidebarOrder.threadIds.push(...result.threadIds);
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Codex project membership sync failed", { cause }).pipe(
            Effect.tap(
              Effect.sync(() => {
                membershipErrorCount++;
              }),
            ),
          ),
        ),
      );
    }
    return {
      sidebarOrder: {
        projectIds: [...new Set(sidebarOrder.projectIds)],
        threadIds: [...new Set(sidebarOrder.threadIds)],
      },
      membershipErrorCount,
      importedCount,
      skippedCount,
      unlinkedProjectCount,
      truncated: scan.truncated === true,
    };
  });
  const move = (input: { threadId: ThreadId; projectId: ProjectId; beforeThreadId?: ThreadId }) =>
    moveCodexMembership(input.threadId, input.projectId, input.beforeThreadId).pipe(
      Effect.filterOrFail(
        (result) => !("moveConfirmation" in result),
        () =>
          new AgentSessionScanError({
            operation: "read-projects",
            cause: null,
            detail:
              "This move needs folder access confirmation. Update T3 and confirm the move in the project sidebar.",
          }),
      ),
      Effect.scoped,
      Effect.timeout("30 seconds"),
      Effect.mapError(
        (cause) =>
          new AgentSessionScanError({
            operation: "read-projects",
            cause,
            ...(cause instanceof Error ? { detail: cause.message } : {}),
          }),
      ),
    );
  return {
    importRecentAgentThreads,
    sync: sync.pipe(syncLock.withPermits(1)),
    organize: (input: AgentSessionOrganizeInput) =>
      organizeCodex(input).pipe(
        Effect.scoped,
        Effect.timeout("30 seconds"),
        Effect.mapError(
          (cause) =>
            new AgentSessionScanError({
              operation: "read-projects",
              cause,
              ...(cause instanceof Error ? { detail: cause.message } : {}),
            }),
        ),
        syncLock.withPermits(1),
      ),
    move: (input: { threadId: ThreadId; projectId: ProjectId; beforeThreadId?: ThreadId }) =>
      move(input).pipe(syncLock.withPermits(1)),
  };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
