import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "./ProjectService.ts";
import { CodexDesktopUnavailable, requestDesktopPipe } from "./CodexDesktopBridge.ts";
import {
  moveCodexMembership,
  organizeCodex,
  synchronizeCodexMembership,
  type RawClient,
} from "./CodexProjectMembership.ts";

const stubs = vi.hoisted(() => ({
  native: vi.fn<RawClient["request"]>(),
  desktop: vi.fn<ReturnType<typeof requestDesktopPipe>>(),
  connect: vi.fn(),
}));
vi.mock("../provider/CodexProvider.ts", () => ({
  withCodexAppServerClient: (options: unknown) => {
    stubs.connect(options);
    return Effect.succeed({ client: { raw: { request: stubs.native } } });
  },
}));
vi.mock("./CodexDesktopBridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./CodexDesktopBridge.ts")>()),
  requestDesktopPipe: () => stubs.desktop,
}));

const projectId = ProjectId.make("isolated-project");
const threadId = ThreadId.make("isolated-thread");
const secondProjectId = ProjectId.make("second-project");
const unsyncedProjectId = ProjectId.make("unsynced-project");
const secondThreadId = ThreadId.make("second-thread");
const testEnvironment = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ServerConfig.layerTest("/isolated/project", { prefix: "t3-codex-organization-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
const setup = Effect.gen(function* () {
  stubs.native.mockReset();
  stubs.desktop.mockReset();
  stubs.connect.mockReset();
  const homePath = (yield* Path.Path).resolve("/isolated/codex-home");
  const desktopState = {
    "app-server-project-id-by-legacy-project-id-by-host": {
      [`local:${homePath}`]: { first: "native-project", second: "native-second-project" },
    },
    "local-projects": {
      first: { name: "Original", rootPaths: ["/isolated/project"] },
      second: { name: "Second", rootPaths: ["/isolated/second-project"] },
    },
    "project-order": ["first", "second"],
    "sidebar-project-thread-orders": {
      first: { threadIds: ["native-second-thread", "native-thread"] },
      second: { threadIds: [] as string[] },
    },
    "thread-project-assignments": {
      "native-thread": { projectKind: "local", projectId: "first" },
      "native-second-thread": { projectKind: "local", projectId: "first" },
    } as Record<string, { projectKind: string; projectId: string }>,
  };
  const project = {
    id: projectId,
    title: "Original",
    workspaceRoot: "/isolated/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    deletedAt: null,
  };
  const writes: unknown[] = [];
  const records = {
    thread: {
      id: threadId,
      title: "Original",
      activeProviderThreadId: "provider",
      projectId,
      organizationProjectId: projectId,
      deletedAt: null,
    },
    providerThreads: [
      {
        id: "provider",
        driver: "codex",
        providerInstanceId: "codex",
        nativeThreadRef: { nativeId: "native-thread" },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const services = Layer.mergeAll(
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          codex: {
            driver: "codex",
            displayName: "Isolated Codex",
            config: { homePath },
          },
          "codex-other": {
            driver: "codex",
            displayName: "Other isolated Codex",
            config: { homePath, binaryPath: "isolated-codex-other" },
          },
        },
      }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeedSome(
          id === secondProjectId
            ? { ...project, id, title: "Second", workspaceRoot: "/isolated/second-project" }
            : id === unsyncedProjectId
              ? { ...project, id, title: "T3 only", workspaceRoot: "/isolated/t3-only" }
              : project,
        ),
      update: (input) =>
        Effect.sync(() => {
          writes.push(input);
          Object.assign(project, { title: input.title ?? project.title });
          return project;
        }),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadRecords: (id) =>
        Effect.succeed(
          id === secondThreadId
            ? {
                ...records,
                thread: { ...records.thread, id },
                providerThreads: [
                  {
                    ...records.providerThreads[0]!,
                    nativeThreadRef: {
                      ...records.providerThreads[0]!.nativeThreadRef!,
                      nativeId: "native-second-thread",
                    },
                  },
                ],
              }
            : records,
        ),
      dispatch: (input) =>
        Effect.sync(() => {
          writes.push(input);
          if (
            input.type === "thread.metadata.update" &&
            input.threadId === threadId &&
            "organizationProjectId" in input
          )
            Object.assign(records.thread, { organizationProjectId: input.organizationProjectId });
          return { sequence: writes.length, storedEvents: [] };
        }),
    }),
    Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        readFileString: () => Effect.succeed(JSON.stringify(desktopState)),
      }),
    ),
  );
  return { services, writes, desktopState };
});

it.effect("does not change a synced chat until Codex acknowledges its rename", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    const called = yield* Deferred.make<void>();
    const acknowledged = yield* Deferred.make<unknown>();
    stubs.desktop.mockImplementation((method) =>
      method === "tools/list"
        ? Effect.succeed({ tools: [{ name: "set_thread_title", namespace: "codex_app" }] })
        : Deferred.succeed(called, undefined).pipe(Effect.andThen(Deferred.await(acknowledged))),
    );
    const pending = yield* organizeCodex({
      action: "rename-thread",
      threadId,
      title: "Confirmed",
    }).pipe(Effect.provide(h.services), Effect.forkChild);
    yield* Deferred.await(called);
    expect(h.writes).toEqual([]);
    yield* Deferred.succeed(acknowledged, { success: true });
    yield* Fiber.join(pending);
    expect(h.writes).toMatchObject([{ type: "thread.metadata.update", title: "Confirmed" }]);
    expect(stubs.native).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(testEnvironment)),
);

it.effect("leaves T3 untouched when Codex is disconnected or rejects a rename", () =>
  Effect.gen(function* () {
    for (const connected of [false, true]) {
      const h = yield* setup;
      stubs.desktop.mockImplementation((method) =>
        !connected
          ? Effect.fail(new CodexDesktopUnavailable({ message: "desktop disconnected" }))
          : Effect.succeed(
              method === "tools/list"
                ? { tools: [{ name: "set_thread_title", namespace: "codex_app" }] }
                : { success: false },
            ),
      );
      const result = yield* Effect.result(
        organizeCodex({ action: "rename-thread", threadId, title: "Rejected" }).pipe(
          Effect.provide(h.services),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(h.writes).toEqual([]);
      expect(stubs.native).not.toHaveBeenCalled();
    }
  }).pipe(Effect.scoped, Effect.provide(testEnvironment)),
);

it.effect("keeps project renaming disabled even with a matching desktop name", () =>
  Effect.gen(function* () {
    for (const [connected, desktopConfirmed] of [
      [false, false],
      [true, false],
      [true, true],
    ]) {
      const h = yield* setup;
      if (desktopConfirmed) h.desktopState["local-projects"].first.name = "Confirmed";
      let name = "Original";
      stubs.native.mockImplementation((method, params) =>
        Effect.sync(() => {
          if (method === "project/update") name = (params as { name: string }).name;
          if (method === "project/list")
            return {
              data: [
                {
                  id: "native-project",
                  name,
                  updatedAt: 1,
                  roots: [{ path: "/isolated/project" }],
                  metadata: { "t3code.projectId": projectId },
                },
              ],
            };
          if (method === "thread/list") return { data: [] };
          return {};
        }),
      );
      stubs.desktop.mockImplementation(() =>
        connected
          ? Effect.succeed({ tools: [{ name: "list_projects", namespace: "codex_app" }] })
          : Effect.fail(new CodexDesktopUnavailable({ message: "desktop disconnected" })),
      );
      const result = yield* Effect.result(
        organizeCodex({ action: "rename-project", projectId, title: "Confirmed" }).pipe(
          Effect.provide(h.services),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(h.writes).toEqual([]);
      expect(name).toBe("Original");
      expect(stubs.native).not.toHaveBeenCalled();
      expect(stubs.desktop).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).toContain("Project renaming from T3 is temporarily disabled");
    }
  }).pipe(Effect.scoped, Effect.provide(testEnvironment)),
);

it.effect(
  "moves chats both ways, preserves manual chat order, and reorders projects through Codex",
  () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      for (const [id, native] of [
        [threadId, "native-thread"],
        [secondThreadId, "native-second-thread"],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${id}, ${projectId}, 'Original', 'codex', 'full-access', 'default', '2026-11-01', '2026-11-01', '{}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, provider, driver, provider_instance_id, status, updated_at, payload_json)
        VALUES (${id}, ${id}, 'codex', 'codex', 'codex', 'idle', '2026-11-01', ${JSON.stringify({ nativeThreadRef: { nativeId: native } })})`;
      }
      let currentProject = "native-project";
      let accepted = true;
      let desktopApproved = false;
      let desktopPersists = true;
      let orderPersists = true;
      let nativeAccepted = true;
      const roots = new Map([
        ["native-project", [{ path: "/isolated/project" }]],
        ["native-second-project", [{ path: "/isolated/second-project" }]],
      ]);
      stubs.native.mockImplementation((method, params) =>
        Effect.sync(() => {
          if (method === "project/list")
            return {
              data: [
                {
                  id: "native-project",
                  name: "Original",
                  updatedAt: 1,
                  roots: roots.get("native-project"),
                  metadata: { "t3code.projectId": projectId },
                },
                {
                  id: "native-second-project",
                  name: "Second",
                  updatedAt: 1,
                  roots: roots.get("native-second-project"),
                  metadata: { "t3code.projectId": secondProjectId },
                },
              ],
            };
          if (method === "thread/read")
            return {
              thread: { id: "native-thread", projectId: currentProject, cwd: "/isolated/project" },
            };
          if (method === "project/update") {
            const patch = params as { projectId: string; roots: { path: string }[] };
            roots.set(patch.projectId, patch.roots);
            return {};
          }
          if (method === "thread/metadata/update") {
            if (nativeAccepted) currentProject = (params as { projectId: string }).projectId;
            return {};
          }
          if (method === "thread/list")
            return {
              data: [
                { id: "native-thread", name: "Original", projectId: currentProject },
                { id: "native-second-thread", name: "Original", projectId: "native-project" },
              ],
            };
          throw new CodexDesktopUnavailable({ message: `Unexpected native write: ${method}` });
        }),
      );
      let manual = false;
      stubs.desktop.mockImplementation((method, params) =>
        Effect.sync(() => {
          if (method === "tools/list")
            return {
              tools: [
                "list_projects",
                "move_thread_to_project",
                "reorder_sidebar_projects",
                "update_sidebar_preferences",
              ].map((name) => ({ name, namespace: "codex_app" })),
            };
          if (!accepted) return { success: false };
          const call = params as {
            tool: string;
            arguments: {
              threadId: string;
              projectId: string;
              projectIds: string[];
              beforeThreadId?: string;
            };
          };
          if (call.tool === "update_sidebar_preferences") {
            manual = true;
          } else if (call.tool === "move_thread_to_project") {
            if (!desktopApproved)
              return {
                success: false,
                contentItems: [
                  {
                    text: JSON.stringify({
                      error: "confirmation_required",
                      projectId: call.arguments.projectId,
                      missingProjectSources: ["/isolated/project"],
                      targetProjectName: "Second",
                    }),
                  },
                ],
              };
            const destination =
              call.arguments.projectId === "second" ? "native-second-project" : "native-project";
            if (destination === currentProject && !manual)
              return {
                success: false,
                contentItems: [{ text: "Project positioning requires manual project sorting." }],
              };
            const order = h.desktopState["sidebar-project-thread-orders"].first.threadIds;
            if (call.arguments.beforeThreadId && orderPersists) {
              const peers = order.filter((id) => id !== call.arguments.threadId);
              peers.splice(
                peers.indexOf(call.arguments.beforeThreadId),
                0,
                call.arguments.threadId,
              );
              h.desktopState["sidebar-project-thread-orders"].first.threadIds = peers;
            }
            if (desktopPersists)
              h.desktopState["thread-project-assignments"][call.arguments.threadId] = {
                projectKind: "local",
                projectId: call.arguments.projectId,
              };
          } else if (orderPersists) {
            h.desktopState["project-order"] = call.arguments.projectIds;
          }
          return { success: true };
        }),
      );
      const previousWrites = h.writes.length;
      for (const sourcePaths of [[], ["/isolated/project"], ["/unrelated"]]) {
        const preview = yield* organizeCodex({
          action: "move-thread",
          threadId,
          projectId: secondProjectId,
          confirmedSourcePaths: sourcePaths,
        }).pipe(Effect.provide(h.services));
        expect(preview).toHaveProperty("moveConfirmation");
        expect(currentProject).toBe("native-project");
        expect(h.writes).toHaveLength(previousWrites);
      }
      expect(
        stubs.native.mock.calls.some(
          ([method]) => method === "project/update" || method === "thread/metadata/update",
        ),
      ).toBe(false);
      desktopApproved = true;
      for (const id of ["native-project", "native-second-project"])
        roots.set(id, [{ path: "/isolated/project" }, { path: "/isolated/second-project" }]);
      h.desktopState["local-projects"].first.rootPaths = roots
        .get("native-project")!
        .map((root) => root.path);
      h.desktopState["local-projects"].second.rootPaths = roots
        .get("native-second-project")!
        .map((root) => root.path);
      for (const target of [secondProjectId, projectId]) {
        const moved = yield* moveCodexMembership(threadId, target).pipe(Effect.provide(h.services));
        expect("desktopRefreshRequired" in moved && moved.desktopRefreshRequired).toBeFalsy();
        expect(h.writes.at(-1)).toMatchObject({ organizationProjectId: target });
        expect(currentProject).toBe(
          target === projectId ? "native-project" : "native-second-project",
        );
      }
      desktopPersists = false;
      const beforeUnconfirmedWrites = h.writes.length;
      expect(
        (yield* Effect.result(
          moveCodexMembership(threadId, secondProjectId).pipe(Effect.provide(h.services)),
        ))._tag,
      ).toBe("Failure");
      expect(currentProject).toBe("native-project");
      expect(h.writes).toHaveLength(beforeUnconfirmedWrites);
      desktopPersists = true;
      nativeAccepted = false;
      expect(
        (yield* Effect.result(
          moveCodexMembership(threadId, secondProjectId).pipe(Effect.provide(h.services)),
        ))._tag,
      ).toBe("Failure");
      expect(currentProject).toBe("native-project");
      expect(h.writes).toHaveLength(beforeUnconfirmedWrites);
      nativeAccepted = true;
      h.desktopState["thread-project-assignments"]["native-thread"]!.projectId = "first";
      orderPersists = false;
      const reordered = yield* moveCodexMembership(threadId, projectId, secondThreadId).pipe(
        Effect.provide(h.services),
      );
      expect(reordered.threadIds).toEqual([threadId, secondThreadId]);
      expect(manual).toBe(true);
      orderPersists = true;
      h.desktopState["sidebar-project-thread-orders"].first.threadIds = [
        "native-thread",
        "native-second-thread",
      ];
      const appended = yield* moveCodexMembership(threadId, projectId).pipe(
        Effect.provide(h.services),
      );
      expect(appended.threadIds).toEqual([secondThreadId, threadId]);
      orderPersists = false;
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET provider_instance_id = 'codex-other'`;
      const projects = yield* organizeCodex({
        action: "reorder-projects",
        providerInstanceId: ProviderInstanceId.make("codex-other"),
        projectIds: [secondProjectId, unsyncedProjectId, projectId],
      }).pipe(Effect.provide(h.services));
      expect(stubs.connect).toHaveBeenLastCalledWith(
        expect.objectContaining({ binaryPath: "isolated-codex-other" }),
      );
      expect(projects.projectIds).toEqual([secondProjectId, projectId]);
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET provider_instance_id = 'codex'`;
      h.desktopState["project-order"] = ["second", "first"];
      expect(
        (yield* Effect.result(
          synchronizeCodexMembership(ProviderInstanceId.make("codex")).pipe(
            Effect.provide(h.services),
          ),
        ))._tag,
      ).toBe("Success");
      h.desktopState["thread-project-assignments"]["native-thread"]!.projectId = "second";
      expect(
        (yield* Effect.result(
          synchronizeCodexMembership(ProviderInstanceId.make("codex")).pipe(
            Effect.provide(h.services),
          ),
        ))._tag,
      ).toBe("Failure");
      const beforeRejectedWrites = h.writes.length;
      accepted = false;
      expect(
        (yield* Effect.result(
          moveCodexMembership(threadId, secondProjectId).pipe(Effect.provide(h.services)),
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.result(
          organizeCodex({
            action: "reorder-projects",
            projectIds: [projectId, secondProjectId],
          }).pipe(Effect.provide(h.services)),
        ))._tag,
      ).toBe("Failure");
      expect(h.writes).toHaveLength(beforeRejectedWrites);
      expect(currentProject).toBe("native-project");
      expect(h.desktopState["project-order"]).toEqual(["second", "first"]);
    }).pipe(Effect.scoped, Effect.provide(testEnvironment)),
);
