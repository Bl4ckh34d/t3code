import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AgentSessionSource,
  EventId,
  MessageId,
  TurnItemId,
  RunId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ServerSettings as ServerSettingsSchema,
  type ApplicationStoredEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ServerConfig from "../config.ts";
import { readCodexThreadOwners, pullCodexMembership } from "./CodexProjectMembership.ts";
import { desktopBridge } from "./CodexDesktopBridge.ts";
import * as CodexMembership from "./CodexProjectMembership.ts";
import * as ServerSettings from "../serverSettings.ts";

const nativeHistory = vi.hoisted(() => vi.fn());
vi.mock("./CodexHistory.ts", () => ({
  synchronizeCodexHistory: (...args: readonly unknown[]) => nativeHistory(...args),
}));
const decodeSettings = Schema.decodeEffect(ServerSettingsSchema);

const projectId = ProjectId.make("agent-session-import-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
  TurnItemPositionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
);

function candidate(
  modelSelection: typeof CODEX_MODEL_SELECTION,
  providerSessionId: string,
  provider: AgentSessionSource = "codex",
) {
  const providerInstanceId = modelSelection.instanceId;
  return {
    _tag: "Importable" as const,
    source: {
      provider,
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerInstanceId}/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId,
      title: "Imported thread",
      model: modelSelection.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
  } satisfies AgentSessionScanner.AgentSessionRecentThread;
}

const PI_MODEL_SELECTION = { instanceId: ProviderInstanceId.make("pi"), model: "default" };

it.effect("imports the unconfigured default Codex provider on a fresh server exactly once", () =>
  Effect.gen(function* () {
    const source = candidate(CODEX_MODEL_SELECTION, "fresh-server-chat");
    nativeHistory.mockReset();
    nativeHistory.mockImplementation(
      (
        _instance,
        ingest: (
          native: {
            id: string;
            cwd: string;
            name: string;
            preview: string;
            archived: boolean;
            createdAt: number;
            updatedAt: number;
          },
          messages: AgentSessionScanner.AgentSessionThreadMessage[],
        ) => Effect.Effect<void>,
      ) =>
        ingest(
          {
            id: source.thread.providerSessionId,
            cwd: "/workspace/project",
            name: source.thread.title,
            preview: "Fix it",
            archived: false,
            createdAt: 1,
            updatedAt: 2,
          },
          [...source.thread.messages],
        ).pipe(Effect.as(0)),
    );
    using _membership = vi.spyOn(CodexMembership, "synchronizeCodexMembership").mockReturnValue(
      Effect.succeed({
        updated: 0,
        desktopRefreshRequired: false,
        projectIds: [],
        threadIds: [],
      }),
    );
    const importer = yield* makeImporter([]);
    const settings = yield* decodeSettings({});
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(
        yield* importer.sync().pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ServerSettings.ServerSettingsService)({
                getSettings: Effect.succeed(settings),
              }),
            ),
          ),
        ),
      ).toMatchObject({ importedCount: 1, skippedCount: 0, membershipErrorCount: 0 });
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      expect(
        (yield* projections.getThreadRecords(importId(source), ["messages"])).messages.map(
          (m) => m.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
    }
    for (const disabled of [{ enabled: false }, { config: { enabled: false } }]) {
      const disabledSettings = yield* decodeSettings({
        providerInstances: { codex: { driver: "codex", ...disabled } },
      });
      expect(
        yield* importer.sync().pipe(
          Effect.provide(
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed(disabledSettings),
            }),
          ),
        ),
      ).toMatchObject({ importedCount: 0, skippedCount: 0, membershipErrorCount: 0 });
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        persistence,
        ServerConfig.layerTest("/workspace/project", { prefix: "t3-default-codex-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  ),
);

it.effect(
  "uses the connected Codex desktop's project context while native migration is incomplete",
  () =>
    Effect.gen(function* () {
      const source = candidate(CODEX_MODEL_SELECTION, "current-live-chat");
      const importer = yield* makeImporter([source]);
      yield* importer.run;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const target = ProjectId.make("desktop-project");
      const writes: unknown[] = [];
      const project = {
        id: target,
        title: "Desktop project",
        workspaceRoot: "/repo",
        scripts: [],
        defaultModelSelection: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      };
      for (const scenario of [
        { remote: false, reported: "legacy", pending: undefined, complete: false, context: false },
        {
          remote: true,
          reported: "remote-project",
          pending: undefined,
          complete: false,
          context: true,
        },
        { remote: false, reported: null, pending: "legacy", complete: false, context: false },
        { remote: false, reported: null, pending: "legacy", complete: false, context: true },
        { remote: false, reported: "legacy", pending: null, complete: false, context: false },
        { remote: false, reported: null, pending: "legacy", complete: true, context: false },
      ]) {
        const { remote } = scenario;
        const reportedDesktop = desktopBridge((method) =>
          method === "tools/list"
            ? Effect.succeed({ tools: [{ name: "list_threads", namespace: "codex_app" }] })
            : Effect.succeed({
                success: true,
                contentItems: [
                  {
                    text: JSON.stringify({
                      threads: [
                        { id: "current-live-chat", projectId: scenario.reported, hostId: "local" },
                      ],
                      nextCursor: null,
                    }),
                  },
                ],
              }),
        );
        writes.length = 0;
        yield* pullCodexMembership(
          CODEX_MODEL_SELECTION.instanceId,
          {
            request: (method, params) =>
              Effect.succeed(
                method === "project/list"
                  ? {
                      data: remote
                        ? []
                        : [
                            {
                              id: "native-project",
                              name: project.title,
                              roots: [{ path: "/repo" }],
                              metadata: { "t3code.projectId": target },
                            },
                          ],
                    }
                  : {
                      data: (params as { archived?: boolean }).archived
                        ? []
                        : [{ id: "current-live-chat", projectId: null, name: "Current chat" }],
                    },
              ),
          },
          {
            "app-server-project-id-by-legacy-project-id-by-host": {
              "local:/codex": { legacy: "native-project" },
            },
            "local-projects": { legacy: { name: project.title, rootPaths: ["/repo"] } },
            "app-server-projects-migration-by-host": {
              "local:/codex": {
                threadAssignmentsMigrated: scenario.complete,
                pendingThreadAssignmentIds:
                  scenario.pending === undefined ? [] : ["current-live-chat"],
              },
            },
            "thread-project-assignments":
              scenario.pending === "legacy"
                ? { "current-live-chat": { projectKind: "local", projectId: "legacy" } }
                : {},
            "projectless-thread-ids": scenario.pending === null ? ["current-live-chat"] : [],
          },
          "/codex",
          scenario.context ? undefined : reportedDesktop,
          scenario.context
            ? {
                providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
                hostId: remote ? "ssh:server" : "local",
                label: "Server",
                sshAlias: "server",
                projects: [
                  {
                    id: remote ? "remote-project" : "legacy",
                    title: "Desktop project",
                    workspaceRoot: "/repo",
                  },
                ],
                assignments: [{ threadId: "current-live-chat", projectId: scenario.reported }],
              }
            : undefined,
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerConfig.layerTest("/repo", { prefix: "t3-desktop-context-" }).pipe(
                Layer.provideMerge(NodeServices.layer),
              ),
              Layer.mock(ProjectService.ProjectService)({
                getById: (id) =>
                  Effect.succeed(id === target ? Option.some(project) : Option.none()),
                update: () => Effect.succeed(project),
                bootstrap: (input) =>
                  Effect.succeed({ project: { ...project, id: input.projectId }, created: true }),
              }),
              Layer.mock(Orchestrator.OrchestratorV2)({
                getThreadRecords: (id, fields) =>
                  projections
                    .getThreadRecords(id, fields)
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
                      ),
                    ),
                dispatch: (input) =>
                  Effect.sync(() => {
                    writes.push(input);
                    return { sequence: 1, storedEvents: [] };
                  }),
              }),
            ),
          ),
        );
        expect(writes).toMatchObject([
          {
            type: "thread.metadata.update",
            organizationProjectId: remote
              ? ProjectId.make("codex-project:codex:remote-project")
              : scenario.pending === null || scenario.complete
                ? ProjectId.make("codex-unassigned-history")
                : target,
          },
        ]);
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("pulls Codex desktop names and order without writing to Codex", () =>
  Effect.gen(function* () {
    let project = {
      id: projectId,
      title: "T3 rename",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
    for (const native of [
      { name: "Old", updatedAt: undefined, expected: "Codex desktop rename" },
      { name: "Confirmed native rename", updatedAt: 1, expected: "Confirmed native rename" },
    ]) {
      const result = yield* pullCodexMembership(
        CODEX_MODEL_SELECTION.instanceId,
        {
          request: (method) =>
            method === "project/list"
              ? Effect.succeed({
                  data: [
                    {
                      id: "native",
                      name: native.name,
                      ...(native.updatedAt === undefined ? {} : { updatedAt: native.updatedAt }),
                      roots: [{ path: "/repo" }],
                      metadata: { "t3code.projectId": projectId, "t3code.syncedTitle": "Old" },
                    },
                  ],
                })
              : method === "thread/list"
                ? Effect.succeed({ data: [] })
                : Effect.die(`Pull must not call ${method}`),
        },
        {
          "app-server-project-id-by-legacy-project-id-by-host": {
            "local:/codex": { legacy: "native" },
          },
          "local-projects": { legacy: { name: "Codex desktop rename", rootPaths: ["/repo"] } },
          "project-order": ["legacy"],
        },
        "/codex",
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerConfig.layerTest("/repo", { prefix: "t3-codex-pull-test-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
            Layer.mock(ProjectService.ProjectService)({
              getById: () => Effect.succeedSome(project),
              update: (input) =>
                Effect.sync(() => {
                  Object.assign(project, { title: input.title ?? project.title });
                  return project;
                }),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({}),
          ),
        ),
      );
      expect(project.title).toBe(native.expected);
      expect(result.projectIds).toEqual([projectId]);
      expect(result.threadIds).toEqual([]);
    }
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("restores source order when expanding a legacy capped import", () =>
  Effect.gen(function* () {
    const source = candidate(CODEX_MODEL_SELECTION, "legacy-order");
    const messages = Array.from({ length: 251 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Message ${index}`,
      createdAt: timestamp,
    }));
    const capped = {
      ...source,
      thread: { ...source.thread, messages: [messages[0]!, ...messages.slice(-199)] },
    };
    yield* (yield* makeImporter([capped])).run;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = importId(source);
    const initial = yield* projections.getThreadRecords(threadId, ["messages", "turnItems"]);
    const nativeMessageId = MessageId.make("t3-authored-message");
    const nativeItemId = TurnItemId.make("t3-authored-item");
    const runId = RunId.make("t3-resumed-run");
    const ordinal = yield* (yield* TurnItemPositionStore.TurnItemPositionStoreV2).allocate({
      threadId,
      turnItemId: nativeItemId,
      runId,
      runOrdinal: 1,
    });
    const firstItem = initial.turnItems.find((item) => item.type === "user_message")!;
    if (firstItem.type !== "user_message") return;
    const nativeItem = {
      ...firstItem,
      id: nativeItemId,
      messageId: nativeMessageId,
      runId,
      ordinal,
      text: "Resumed in T3",
      nativeItemRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "native-resume",
        strength: "strong" as const,
      },
    };
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make("t3-resume-message"),
          threadId,
          occurredAt: now,
          type: "message.updated",
          payload: { ...initial.messages[0]!, id: nativeMessageId, runId, text: "Resumed in T3" },
        },
        {
          id: EventId.make("t3-resume-item"),
          threadId,
          occurredAt: now,
          type: "turn-item.updated",
          payload: nativeItem,
        },
      ],
    });
    const fullMessages = [
      ...messages,
      {
        role: "user" as const,
        text: "Resumed in T3",
        createdAt: timestamp,
        nativeId: "native-resume",
      },
    ];
    const full = { ...source, thread: { ...source.thread, messages: fullMessages } };
    const importer = yield* makeImporter([full]);
    yield* importer.run;
    yield* importer.run;
    const records = yield* projections.getThreadRecords(importId(source), ["turnItems"]);
    const items = [...records.turnItems].sort((a, b) => a.ordinal - b.ordinal);
    expect(items.map((item) => ("text" in item ? item.text : null))).toEqual(
      fullMessages.map((message) => message.text),
    );
    expect(new Set(items.map((item) => item.ordinal)).size).toBe(252);
    expect(items.find((item) => item.id === nativeItemId)).toEqual(nativeItem);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("appends source messages on reimport without duplicating existing history", () =>
  Effect.gen(function* () {
    const original = candidate(CODEX_MODEL_SELECTION, "incremental");
    const source = {
      ...original,
      thread: {
        ...original.thread,
        archived: true,
        originalWorkspaceRoot: "/missing/original-workspace",
      },
    };
    const first = yield* makeImporter([source]);
    yield* first.run;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    expect(
      (yield* projections.getThreadRecords(importId(source), [])).thread.archivedAt,
    ).not.toBeNull();
    const updated = {
      ...source,
      source: { ...source.source, size: 200, mtimeMs: 3 },
      thread: {
        ...source.thread,
        archived: false,
        messages: [
          ...source.thread.messages,
          { role: "user" as const, text: "Another task", createdAt: timestamp },
        ],
      },
    };
    const second = yield* makeImporter([updated]);
    yield* second.run;
    yield* second.run;
    const records = yield* projections.getThreadRecords(importId(source), ["messages"]);
    expect(records.thread.archivedAt).toBeNull();
    expect(records.thread.worktreePath).toBe("/missing/original-workspace");
    expect(records.messages.map((message) => message.text)).toEqual([
      "Fix it",
      "Fixed",
      "Another task",
    ]);
    const repeated = {
      ...updated,
      thread: {
        ...updated.thread,
        archived: true,
        messages: [...updated.thread.messages, updated.thread.messages[2]!],
      },
    };
    const third = yield* makeImporter([repeated]);
    yield* third.run;
    yield* third.run;
    expect(
      (yield* projections.getThreadRecords(importId(source), [])).thread.archivedAt,
    ).not.toBeNull();
    expect(
      (yield* projections.getThreadRecords(importId(source), ["messages"])).messages.map(
        (message) => message.text,
      ),
    ).toEqual(["Fix it", "Fixed", "Another task", "Another task"]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

// Pi threads are owned by their session file path, not the session UUID.
const nativeId = ({ source }: ReturnType<typeof candidate>) =>
  source.provider === "pi" ? source.filePath : source.providerSessionId;

function importId(source: ReturnType<typeof candidate>) {
  return ThreadId.make(
    `import:${source.source.providerInstanceId}:${source.source.providerSessionId}`,
  );
}

const seedOwner = Effect.fn(function* (
  source: ReturnType<typeof candidate>,
  lifecycle: "active" | "archived" | "deleted" = "active",
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { providerInstanceId, providerSessionId, provider } = source.source;
  const nativeThreadId = nativeId(source);
  const threadId = ThreadId.make(`owner:${providerInstanceId}:${providerSessionId}`);
  const driver = ProviderDriverKind.make(provider);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({ driver, nativeThreadId }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Native thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: source.thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: lifecycle === "archived" ? now : null,
    deletedAt: lifecycle === "deleted" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

const makeImporter = Effect.fn(function* (
  candidates: ReadonlyArray<ReturnType<typeof candidate>>,
  beforeTransaction: Effect.Effect<void> = Effect.void,
) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const published: Array<ApplicationStoredEvent> = [];
  const withTransaction: typeof sql.withTransaction = (effect) =>
    beforeTransaction.pipe(Effect.andThen(sql.withTransaction(effect)));
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
  });
  const sinkLayer = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, {
          ...events,
          publishCommitted: (batch) =>
            events.publishCommitted(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  published.push(...batch);
                }),
              ),
            ),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          sinkLayer,
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            recentThreads: () => Stream.fromIterable(candidates),
            scanForSync: Effect.succeed({ candidates: [], truncated: false, scannedAt: timestamp }),
          }),
          Layer.mock(ProjectService.ProjectService)({
            bootstrap: () =>
              Effect.succeed({
                project: {
                  id: projectId,
                  title: "Project",
                  workspaceRoot: "/workspace/project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: timestamp,
                  updatedAt: timestamp,
                  deletedAt: null,
                },
                created: true,
              }),
            getById: () =>
              Effect.succeedSome({
                id: projectId,
                title: "Project",
                workspaceRoot: "/workspace/project",
                defaultModelSelection: null,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: null,
              }),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
        ),
      ),
    ),
  );
  const importer = Context.get(context, AgentSessionImporter.AgentSessionImporter);
  return {
    run: importer.importRecentAgentThreads({ projectId }),
    sync: () => importer.sync().pipe(Effect.provide(context)),
    published,
    importNative: (source: ReturnType<typeof candidate>, target: ThreadId) =>
      importer.importRecentAgentThreads({ projectId }, false, [source], target),
  };
});

it.effect("keeps both native histories when a T3 chat continues under a new Codex ID", () =>
  Effect.gen(function* () {
    const original = candidate(CODEX_MODEL_SELECTION, "original");
    yield* (yield* makeImporter([original])).run;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const records = yield* projections.getThreadRecords(importId(original), ["providerThreads"]);
    const provider = records.providerThreads[0]!;
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make("continued-native-id"),
          type: "provider-thread.updated",
          threadId: records.thread.id,
          occurredAt: now,
          payload: {
            ...provider,
            nativeThreadRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "continued",
              strength: "strong",
            },
          },
        },
      ],
    });
    const target = (id: string) =>
      AgentSessionImporter.codexHistoryTarget(CODEX_MODEL_SELECTION.instanceId, id).pipe(
        Effect.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
        ),
      );
    expect(yield* target("continued")).toBe(records.thread.id);
    const originalTarget = yield* target("original");
    expect(originalTarget).not.toBe(records.thread.id);
    const importer = yield* makeImporter([]);
    const continued = {
      ...candidate(CODEX_MODEL_SELECTION, "continued"),
      thread: {
        ...original.thread,
        providerSessionId: "continued",
        archived: true,
        messages: [{ role: "user" as const, text: "Continued history", createdAt: timestamp }],
      },
    };
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(yield* importer.importNative(original, yield* target("original"))).toMatchObject({
        importedCount: 1,
        skippedCount: 0,
      });
      expect(yield* importer.importNative(continued, yield* target("continued"))).toMatchObject({
        importedCount: 1,
        skippedCount: 0,
      });
      expect(yield* target("original")).toBe(originalTarget);
      const a = yield* projections.getThreadRecords(originalTarget, [
        "messages",
        "providerThreads",
      ]);
      const b = yield* projections.getThreadRecords(records.thread.id, [
        "messages",
        "providerThreads",
      ]);
      expect(a.thread.archivedAt).toBeNull();
      expect(b.thread.archivedAt).not.toBeNull();
      expect(a.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
      expect(b.messages.map((message) => message.text)).toContain("Continued history");
      expect(a.providerThreads[0]?.nativeThreadRef?.nativeId).toBe("original");
      expect(b.providerThreads[0]?.nativeThreadRef?.nativeId).toBe("continued");
    }
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "ignores owned sessions, including archived and deleted threads, but imports other instances and unowned sessions",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const active = candidate(CODEX_MODEL_SELECTION, "active");
      const archived = candidate(
        CLAUDE_MODEL_SELECTION,
        "020e7f00-dce6-406b-8ec6-ed90498945d6",
        "claudeAgent",
      );
      const deleted = candidate(CODEX_MODEL_SELECTION, "deleted");
      const ownedPi = candidate(PI_MODEL_SELECTION, "owned-pi", "pi");
      const owners = [
        yield* seedOwner(active),
        yield* seedOwner(archived, "archived"),
        yield* seedOwner(deleted, "deleted"),
        yield* seedOwner(ownedPi),
      ];
      const before = yield* Effect.forEach(owners, (id) =>
        projections.getThreadRecords(id, ["providerThreads"]),
      );
      const otherInstance = candidate(
        { ...CLAUDE_MODEL_SELECTION, instanceId: ProviderInstanceId.make("claude-other") },
        archived.source.providerSessionId,
        "claudeAgent",
      );
      const unowned = candidate(CODEX_MODEL_SELECTION, "unowned");
      const unownedPi = candidate(PI_MODEL_SELECTION, "unowned-pi", "pi");
      const importer = yield* makeImporter([
        active,
        archived,
        deleted,
        ownedPi,
        otherInstance,
        unowned,
        unownedPi,
      ]);

      expect(yield* importer.run).toEqual({ importedCount: 3, skippedCount: 0 });
      const nativeOwners = yield* readCodexThreadOwners(CODEX_MODEL_SELECTION.instanceId);
      expect(nativeOwners.get(active.source.providerSessionId)).toEqual([owners[0]]);
      for (const source of [active, archived, deleted, ownedPi]) {
        const threadId = importId(source);
        expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
        expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
        expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
      }
      expect(
        yield* Effect.forEach(owners, (id) =>
          projections.getThreadRecords(id, ["providerThreads"]),
        ),
      ).toEqual(before);
      expect(
        new Set(
          importer.published.flatMap((stored) =>
            "event" in stored ? [stored.event.threadId] : [],
          ),
        ),
      ).toEqual(new Set([importId(otherInstance), importId(unowned), importId(unownedPi)]));
      for (const source of [otherInstance, unowned, unownedPi]) {
        const threadId = importId(source);
        const records = yield* projections.getThreadRecords(threadId, [
          "messages",
          "providerThreads",
        ]);
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        expect(records.thread.historyOrigin).toBe("v1_import");
        expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(nativeId(source));
        expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
          providerInstanceId: source.source.providerInstanceId,
          resumeCursor:
            source.source.provider === "claudeAgent"
              ? { threadId, resume: source.source.providerSessionId }
              : { threadId: nativeId(source) },
          runtimePayload: { importedTranscripts: [source.source] },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks ownership after the import reaches the commit transaction", () =>
  Effect.gen(function* () {
    const enteringTransaction = yield* Deferred.make<void>();
    const continueTransaction = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "claimed-during-import");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(enteringTransaction, undefined).pipe(
        Effect.andThen(Deferred.await(continueTransaction)),
      ),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(enteringTransaction);
    // Commit ownership after all pre-transaction reads, before the import acquires SQLite.
    const ownerId = yield* seedOwner(source);
    yield* Deferred.succeed(continueTransaction, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 0 });
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    expect(yield* events.read({ threadId: importId(source) }).pipe(Stream.runCollect)).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
    expect(importer.published).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retries failed commits and runtime persistence without replaying committed history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = candidate(CODEX_MODEL_SELECTION, "retry");
      const threadId = importId(source);
      const importer = yield* makeImporter([source]);
      yield* sql`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtimes.list()).toEqual([]);
      expect(importer.published).toEqual([]);
      yield* sql`DROP TRIGGER fail_import`;

      yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      const committed = yield* events.read({ threadId }).pipe(Stream.runCollect);
      expect(committed).toHaveLength(6);
      expect(importer.published).toHaveLength(6);
      expect(yield* runtimes.list()).toEqual([]);
      yield* sql`DROP TRIGGER fail_runtime`;

      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(committed);
      expect(importer.published).toHaveLength(6);
      expect(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerInstanceId: source.source.providerInstanceId,
        resumeCursor: { threadId: source.source.providerSessionId },
        runtimePayload: { importedTranscripts: [source.source] },
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);
