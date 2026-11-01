import {
  CodexSettings,
  CODEX_PROJECT_RENAME_DISABLED_MESSAGE,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionOrganizeInput,
  type CodexDesktopHistoryContext,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as CodexClient from "effect-codex-app-server/client";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "./ProjectService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  desktopBridge,
  requestDesktopPipe,
  CodexDesktopUnavailable,
} from "./CodexDesktopBridge.ts";

const NativeProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  roots: Schema.Array(
    Schema.StructWithRest(Schema.Struct({ path: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  updatedAt: Schema.optionalKey(Schema.Number),
});
const ProjectPage = Schema.Struct({
  data: Schema.Array(NativeProject),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeProjectPage = Schema.decodeUnknownEffect(ProjectPage);
const decodeSettings = Schema.decodeEffect(CodexSettings);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const ThreadPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.NullOr(Schema.String)),
      projectId: Schema.NullOr(Schema.String),
    }),
  ),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeThreadPage = Schema.decodeUnknownEffect(ThreadPage);
const DesktopThreadPage = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      threadId: Schema.optionalKey(Schema.String),
      projectId: Schema.NullOr(Schema.String),
      hostId: Schema.optionalKey(Schema.String),
    }),
  ),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeDesktopThreadPage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopThreadPage),
);
// Codex defaults to interactive sources, which omits historical exec chats.
const CODEX_SYNC_THREAD_SOURCES = ["cli", "vscode", "exec", "appServer", "unknown"] as const;
export const CODEX_SYNC_THREAD_LIST_PARAMS = {
  sourceKinds: CODEX_SYNC_THREAD_SOURCES,
  modelProviders: [],
  limit: 100,
};
export type RawClient = CodexClient.CodexAppServerClient["Service"]["raw"];
export const request = (raw: Pick<RawClient, "request">, method: string, params: unknown) =>
  raw.request(method, params).pipe(Effect.timeout("30 seconds"));

class MembershipError extends Schema.TaggedError<MembershipError>()("CodexProjectMembershipError", {
  message: Schema.String,
}) {}

export const readCodexProjects = Effect.fn("readCodexProjects")(function* (
  raw: Pick<RawClient, "request">,
) {
  const projects: Array<typeof NativeProject.Type> = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = yield* decodeProjectPage(
      yield* request(raw, "project/list", { limit: 100, ...(cursor ? { cursor } : {}) }),
    );
    projects.push(...page.data);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor))
      return yield* new MembershipError({ message: "Codex repeated a project cursor." });
    if (cursor) seen.add(cursor);
  } while (cursor);
  return projects;
});

const DesktopMigration = Schema.Struct({
  "app-server-project-id-by-legacy-project-id-by-host": Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.String),
  ),
  "app-server-projects-migration-by-host": Schema.Record(
    Schema.String,
    Schema.Struct({
      threadAssignmentsMigrated: Schema.Boolean,
      pendingThreadAssignmentIds: Schema.Array(Schema.String),
    }),
  ),
  "thread-project-assignments": Schema.Record(
    Schema.String,
    Schema.Struct({ projectKind: Schema.String, projectId: Schema.String }),
  ),
  "projectless-thread-ids": Schema.optional(Schema.Array(Schema.String)),
});

const decodeDesktopMigration = Schema.decodeUnknownOption(DesktopMigration);

export function pendingCodexMembership(
  state: unknown,
  homePath: string,
  projectIds: "native" | "desktop" = "native",
): ReadonlyMap<string, string | null> {
  const decoded = decodeDesktopMigration(state);
  const result = new Map<string, string | null>();
  if (Option.isNone(decoded)) return result;
  const data = decoded.value;
  const host = Object.keys(data["app-server-projects-migration-by-host"]).find(
    (key) =>
      key.startsWith("local:") &&
      normalizeProjectPathForComparison(key.slice(6)) ===
        normalizeProjectPathForComparison(homePath),
  );
  if (host === undefined) return result;
  const migration = data["app-server-projects-migration-by-host"][host]!;
  if (migration.threadAssignmentsMigrated) return result;
  const mapping = data["app-server-project-id-by-legacy-project-id-by-host"][host] ?? {};
  const projectless = new Set(data["projectless-thread-ids"] ?? []);
  for (const id of migration.pendingThreadAssignmentIds) {
    const assignment = data["thread-project-assignments"][id];
    if (projectless.has(id)) result.set(id, null);
    else if (assignment?.projectKind === "local" && mapping[assignment.projectId])
      result.set(
        id,
        projectIds === "native" ? mapping[assignment.projectId]! : assignment.projectId,
      );
  }
  return result;
}

const DesktopSidebar = Schema.Struct({
  "thread-project-assignments": Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ projectKind: Schema.String, projectId: Schema.String }),
    ),
  ),
  "app-server-project-id-by-legacy-project-id-by-host": Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.String),
  ),
  "local-projects": Schema.Record(
    Schema.String,
    Schema.Struct({
      name: Schema.String,
      rootPaths: Schema.Array(Schema.String),
    }),
  ),
  "project-order": Schema.optional(Schema.Array(Schema.String)),
  "sidebar-project-thread-orders": Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        threadIds: Schema.Array(Schema.String),
      }),
    ),
  ),
});
const decodeDesktopSidebar = Schema.decodeUnknownOption(DesktopSidebar);

export function codexDesktopSidebar(state: unknown, homePath: string) {
  const projects = new Map<
    string,
    { readonly name: string; readonly rootPaths: readonly string[] }
  >();
  const projectIds: string[] = [];
  const threadIds: string[] = [];
  const projectThreadIds = new Map<string, readonly string[]>();
  const threadProjectIds = new Map<string, string>();
  const nativeProjectIds = new Map<string, string>();
  const decoded = decodeDesktopSidebar(state);
  if (Option.isSome(decoded)) {
    const data = decoded.value;
    const host = Object.keys(data["app-server-project-id-by-legacy-project-id-by-host"]).find(
      (key) =>
        key.startsWith("local:") &&
        normalizeProjectPathForComparison(key.slice(6)) ===
          normalizeProjectPathForComparison(homePath),
    );
    const mapping = host
      ? (data["app-server-project-id-by-legacy-project-id-by-host"][host] ?? {})
      : {};
    for (const [legacy, native] of Object.entries(mapping)) nativeProjectIds.set(legacy, native);
    for (const [threadId, assignment] of Object.entries(data["thread-project-assignments"] ?? {})) {
      const project = mapping[assignment.projectId];
      if (assignment.projectKind === "local" && project) threadProjectIds.set(threadId, project);
    }
    for (const legacy of [
      ...(data["project-order"] ?? []),
      ...Object.keys(data["local-projects"]),
    ]) {
      const id = mapping[legacy];
      const project = data["local-projects"][legacy];
      if (!id || !project || projects.has(id)) continue;
      projects.set(id, project);
      projectIds.push(id);
      const order = data["sidebar-project-thread-orders"]?.[legacy]?.threadIds ?? [];
      projectThreadIds.set(id, order);
      threadIds.push(...order);
    }
  }
  return {
    projects,
    projectIds,
    threadIds: [...new Set(threadIds)],
    projectThreadIds,
    threadProjectIds,
    nativeProjectIds,
  };
}

const readCodexDesktopState = Effect.fn("readCodexDesktopState")(function* (homePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const state = yield* fs
    .readFileString(path.join(homePath, ".codex-global-state.json"))
    .pipe(Effect.flatMap(decodeJson), Effect.option);
  return Option.getOrNull(state);
});

export const readCodexThreadOwners = Effect.fn("readCodexThreadOwners")(function* (
  instanceId: ProviderInstanceId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly thread_id: string; readonly native_id: string }>`
    WITH ranked AS (
      SELECT p.thread_id, p.provider_instance_id, json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
        ROW_NUMBER() OVER (PARTITION BY p.thread_id ORDER BY
          p.provider_thread_id = json_extract(t.payload_json, '$.activeProviderThreadId') DESC,
          json_extract(p.payload_json, '$.createdAt') DESC, p.provider_thread_id DESC) AS priority
      FROM orchestration_v2_projection_provider_threads p
      JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
      WHERE p.driver = 'codex' AND json_extract(p.payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
    )
    SELECT thread_id, native_id FROM ranked
    WHERE priority = 1 AND provider_instance_id = ${instanceId}
  `;
  const owners = new Map<string, Array<ThreadId>>();
  for (const row of rows) {
    const ids = owners.get(row.native_id) ?? [];
    if (!ids.includes(ThreadId.make(row.thread_id))) ids.push(ThreadId.make(row.thread_id));
    owners.set(row.native_id, ids);
  }
  return owners;
});

export const connect = Effect.fn("CodexProjectMembership.connect")(function* (
  instanceId: ProviderInstanceId,
) {
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  const instance = settings.providerInstances[instanceId];
  if (instance && instance.driver !== "codex")
    return yield* new MembershipError({ message: "This chat is not a Codex session." });
  const config = yield* decodeSettings(instance?.config ?? {});
  if (!config.enabled)
    return yield* new MembershipError({ message: "The Codex provider is disabled." });
  const environment = yield* mergeProviderInstanceEnvironment(
    instance?.environment,
    yield* HostProcess.Environment,
  );
  const layout = yield* resolveCodexHomeLayout(
    config.homePath || !environment.CODEX_HOME
      ? config
      : { ...config, homePath: environment.CODEX_HOME },
  );
  const connection = yield* withCodexAppServerClient({
    binaryPath: config.binaryPath,
    homePath: layout.effectiveHomePath ?? layout.sharedHomePath,
    launchArgs: config.launchArgs,
    cwd: yield* HostProcess.HomeDirectory,
    environment,
  });
  const desktopPipePath = config.desktopPipePath || environment.CODEX_APP_TOOLS_PIPE_PATH || "";
  return {
    ...connection,
    homePath: layout.sharedHomePath,
    desktopConfigured: desktopPipePath.length > 0,
    desktop: desktopBridge(requestDesktopPipe(desktopPipePath)),
  };
});

export function incomingCodexTitle(local: string, remote: string | null | undefined) {
  return remote?.trim() || local;
}

export const unassignedCodexProject = Effect.fn("unassignedCodexProject")(function* () {
  const projects = yield* ProjectService.ProjectService;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return (yield* projects.bootstrap({
    commandId: CommandId.make("codex-unassigned-history"),
    projectId: ProjectId.make("codex-unassigned-history"),
    title: "Unassigned Codex chats",
    workspaceRoot: path.join(config.baseDir, "projects", "codex-unassigned-history"),
    createWorkspaceRootIfMissing: true,
  })).project;
});

export const pullCodexMembership = Effect.fn("pullCodexMembership")(function* (
  instanceId: ProviderInstanceId,
  raw: Pick<RawClient, "request">,
  desktopState: unknown,
  homePath: string,
  desktop?: ReturnType<typeof desktopBridge>,
  desktopContext?: CodexDesktopHistoryContext,
) {
  const crypto = yield* Crypto.Crypto;
  const pendingMembership = pendingCodexMembership(desktopState, homePath);
  const sidebar = codexDesktopSidebar(desktopState, homePath);
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const nativeProjects = yield* readCodexProjects(raw);
  const contextProjectIds = new Map<string, string>();
  for (const project of desktopContext?.projects ?? []) {
    const nativeId = sidebar.nativeProjectIds.get(project.id) ?? project.id;
    const existing =
      nativeProjects.find((entry) => entry.id === nativeId) ??
      nativeProjects.find((entry) =>
        entry.roots.some(
          (root) =>
            normalizeProjectPathForComparison(root.path) ===
            normalizeProjectPathForComparison(project.workspaceRoot),
        ),
      );
    contextProjectIds.set(project.id, existing?.id ?? nativeId);
    if (existing)
      nativeProjects[nativeProjects.indexOf(existing)] = { ...existing, name: project.title };
    else
      nativeProjects.push({
        id: nativeId,
        name: project.title,
        roots: [{ path: project.workspaceRoot }],
      });
  }
  const mapping = new Map<string, ProjectId>();
  let mappingErrors = 0;
  let desktopRefreshRequired = false;
  for (const entry of nativeProjects) {
    const desktop = sidebar.projects.get(entry.id);
    if (
      desktop &&
      (desktop.name !== entry.name ||
        desktop.rootPaths.length !== entry.roots.length ||
        entry.roots.some(
          (root) =>
            !desktop.rootPaths.some(
              (path) =>
                normalizeProjectPathForComparison(path) ===
                normalizeProjectPathForComparison(root.path),
            ),
        ))
    )
      desktopRefreshRequired = true;
    const native =
      desktop && entry.updatedAt === undefined
        ? { ...entry, name: desktop.name, roots: desktop.rootPaths.map((path) => ({ path })) }
        : entry;
    yield* Effect.gen(function* () {
      const linkedId = native.metadata?.["t3code.projectId"];
      let local = linkedId ? yield* projects.getById(ProjectId.make(linkedId)) : Option.none();
      const root = native.roots[0];
      if (Option.isNone(local) && root) {
        const created = yield* projects
          .bootstrap({
            commandId: CommandId.make(`codex-project:${instanceId}:${native.id}`),
            projectId: ProjectId.make(`codex-project:${instanceId}:${native.id}`),
            title: native.name,
            workspaceRoot: root.path,
          })
          .pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                const config = yield* ServerConfig.ServerConfig;
                const path = yield* Path.Path;
                return yield* projects.bootstrap({
                  commandId: CommandId.make(`codex-archived-project:${instanceId}:${native.id}`),
                  projectId: ProjectId.make(`codex-archived-project:${instanceId}:${native.id}`),
                  title: native.name,
                  workspaceRoot: path.join(config.baseDir, "projects", `codex-${native.id}`),
                  createWorkspaceRootIfMissing: true,
                });
              }),
            ),
          );
        local = Option.some(created.project);
      }
      if (Option.isSome(local)) {
        mapping.set(native.id, local.value.id);
        if (native.name !== local.value.title)
          yield* projects.update({
            commandId: CommandId.make(`codex-project-name:${yield* crypto.randomUUIDv4()}`),
            projectId: local.value.id,
            title: native.name,
          });
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Codex project mapping failed", { projectId: native.id, cause }).pipe(
          Effect.tap(
            Effect.sync(() => {
              mappingErrors++;
            }),
          ),
        ),
      ),
    );
  }
  const owners = yield* readCodexThreadOwners(instanceId);
  const desktopMembership = new Map<string, string | null>(
    (desktopContext?.assignments ?? []).map((assignment) => [
      assignment.threadId,
      assignment.projectId === null
        ? null
        : (contextProjectIds.get(assignment.projectId) ?? assignment.projectId),
    ]),
  );
  const caller = owners.keys().next().value;
  if (desktop && desktopContext === undefined && caller !== undefined) {
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const result = yield* desktop.read("list_threads", caller, {
          mode: "history",
          source: "codex",
          hostId: "local",
          archived,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        const page = yield* decodeDesktopThreadPage(
          result.contentItems?.find((item) => item.text !== undefined)?.text ?? "",
        );
        for (const thread of page.threads) {
          const id = thread.id ?? thread.threadId;
          if (id === undefined || (thread.hostId !== undefined && thread.hostId !== "local"))
            continue;
          const project =
            thread.projectId === null
              ? null
              : (sidebar.nativeProjectIds.get(thread.projectId) ?? thread.projectId);
          if (project !== null && !mapping.has(project))
            return yield* new MembershipError({
              message:
                "A Codex desktop project has not migrated to native storage. Synchronization is incomplete.",
            });
          desktopMembership.set(id, project);
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor))
          return yield* new MembershipError({ message: "Codex desktop repeated a thread cursor." });
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
  }
  const listedThreadIds: string[] = [];
  let updated = 0;
  const listed = new Set<string>();
  for (const useStateDbOnly of [false, true]) {
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = yield* decodeThreadPage(
          yield* request(raw, "thread/list", {
            ...CODEX_SYNC_THREAD_LIST_PARAMS,
            useStateDbOnly,
            archived,
            sortKey: "updated_at",
            ...(cursor ? { cursor } : {}),
          }),
        );
        for (const native of page.data) {
          if (listed.has(native.id)) continue;
          listed.add(native.id);
          if (
            owners.has(native.id) &&
            !desktopMembership.has(native.id) &&
            sidebar.threadProjectIds.has(native.id) &&
            sidebar.threadProjectIds.get(native.id) !== native.projectId &&
            !pendingMembership.has(native.id)
          )
            desktopRefreshRequired = true;
          listedThreadIds.push(native.id);
          let nativeProjectId = native.projectId;
          // Desktop history reports null until its pending project migration commits.
          const pendingProjectId = pendingMembership.has(native.id)
            ? pendingMembership.get(native.id)
            : desktopMembership.get(native.id);
          if (pendingProjectId !== undefined) {
            nativeProjectId = pendingProjectId;
          }
          const target =
            nativeProjectId === null
              ? owners.has(native.id)
                ? (yield* unassignedCodexProject()).id
                : null
              : mapping.get(nativeProjectId);
          if (target === undefined) continue;
          for (const threadId of owners.get(native.id) ?? []) {
            const records = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
            if (Option.isNone(records) || records.value.thread.deletedAt !== null) continue;
            if (
              desktopContext === undefined &&
              desktop === undefined &&
              mapping.size === 0 &&
              nativeProjectId === null &&
              records.value.thread.organizationProjectId != null &&
              records.value.thread.organizationProjectId !== "codex-unassigned-history"
            )
              return yield* new MembershipError({
                message:
                  "Connect the original Codex desktop before synchronizing its project membership.",
              });
            const title = incomingCodexTitle(records.value.thread.title, native.name);
            if (
              (records.value.thread.organizationProjectId ?? null) === target &&
              records.value.thread.title === title
            )
              continue;
            yield* orchestrator.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`codex-membership:${yield* crypto.randomUUIDv4()}`),
              threadId,
              organizationProjectId: target,
              expectedTitle: records.value.thread.title,
              title,
              codexSyncedTitle: title,
            });
            updated++;
          }
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor))
          return yield* new MembershipError({ message: "Codex repeated a thread cursor." });
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
  }
  if (mappingErrors > 0)
    return yield* new MembershipError({
      message: `${mappingErrors} Codex projects could not be linked.`,
    });
  return {
    updated,
    desktopRefreshRequired,
    projectIds: [
      ...new Set(
        [...sidebar.projectIds, ...nativeProjects.map((project) => project.id)].flatMap(
          (id) => mapping.get(id) ?? [],
        ),
      ),
    ],
    threadIds: [
      ...new Set([...sidebar.threadIds, ...listedThreadIds].flatMap((id) => owners.get(id) ?? [])),
    ],
  };
});

export const synchronizeCodexMembership = Effect.fn("synchronizeCodexMembership")(function* (
  instanceId: ProviderInstanceId,
  desktopContext?: CodexDesktopHistoryContext,
) {
  const { client, homePath, desktop, desktopConfigured } = yield* connect(instanceId);
  const result = yield* pullCodexMembership(
    instanceId,
    client.raw,
    yield* readCodexDesktopState(homePath),
    homePath,
    desktopConfigured ? desktop : undefined,
    desktopContext,
  );
  if (result.desktopRefreshRequired)
    return yield* new MembershipError({
      message:
        "Codex storage and the Codex desktop sidebar disagree. Desktop synchronization is incomplete.",
    });
  return result;
});

export const moveCodexMembership = Effect.fn("moveCodexMembership")(function* (
  threadId: ThreadId,
  projectId: ProjectId,
  beforeThreadId?: ThreadId,
) {
  const crypto = yield* Crypto.Crypto;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const records = yield* orchestrator.getThreadRecords(threadId, ["providerThreads"]);
  const target = yield* projects.getById(projectId);
  if (records.thread.deletedAt !== null)
    return yield* new MembershipError({ message: "The chat no longer exists." });
  if (Option.isNone(target) || target.value.deletedAt !== null)
    return yield* new MembershipError({ message: "The destination project no longer exists." });
  const codexThreads = records.providerThreads.filter(
    (entry) => entry.driver === "codex" && entry.nativeThreadRef !== null,
  );
  const preferred =
    codexThreads.find((entry) => entry.id === records.thread.activeProviderThreadId) ??
    codexThreads.toSorted(
      (a, b) =>
        DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt) ||
        b.id.localeCompare(a.id),
    )[0];
  let sidebarOrder = {
    projectIds: [] as ProjectId[],
    threadIds: [] as ThreadId[],
    desktopRefreshRequired: false,
  };
  for (const providerThread of preferred ? [preferred] : []) {
    const nativeId = providerThread.nativeThreadRef?.nativeId;
    if (!nativeId)
      return yield* new MembershipError({ message: "The Codex chat has no native identifier." });
    const { client, desktop, homePath } = yield* connect(providerThread.providerInstanceId);
    yield* desktop.requireTool("move_thread_to_project");
    const nativeProjects = yield* readCodexProjects(client.raw);
    const native =
      nativeProjects.find((entry) => entry.metadata?.["t3code.projectId"] === projectId) ??
      nativeProjects.find((entry) =>
        entry.roots.some(
          (root) =>
            normalizeProjectPathForComparison(root.path) ===
            normalizeProjectPathForComparison(target.value.workspaceRoot),
        ),
      );
    if (!native) {
      return yield* new MembershipError({
        message: "Synchronize this project from Codex before moving chats into it.",
      });
    }
    const position = yield* request(client.raw, "thread/read", {
      threadId: nativeId,
      includeTurns: false,
    }).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            thread: Schema.Struct({ projectId: Schema.NullOr(Schema.String), cwd: Schema.String }),
          }),
        ),
      ),
    );
    const sameProject = position.thread.projectId === native.id;
    let beforeNativeId: string | undefined;
    if (beforeThreadId) {
      const before = yield* orchestrator.getThreadRecords(beforeThreadId, ["providerThreads"]);
      const ref = before.providerThreads.find(
        (entry) =>
          entry.driver === "codex" &&
          entry.providerInstanceId === providerThread.providerInstanceId &&
          entry.nativeThreadRef !== null,
      );
      if (!ref?.nativeThreadRef?.nativeId)
        return yield* new MembershipError({
          message: "The destination chat is not part of this Codex connection.",
        });
      beforeNativeId = ref.nativeThreadRef.nativeId;
    }
    if (beforeThreadId || sameProject) {
      yield* desktop.call("update_sidebar_preferences", nativeId, { sorting: { chats: "manual" } });
    }
    const destinationId = yield* desktopProjectId(native.id, homePath);
    const append = sameProject && !beforeNativeId;
    if (append) {
      const order =
        codexDesktopSidebar(yield* readCodexDesktopState(homePath), homePath).projectThreadIds.get(
          native.id,
        ) ?? [];
      const index = order.indexOf(nativeId);
      if (index < 0)
        return yield* new MembershipError({
          message: "Synchronize the Codex sidebar order before reordering this chat.",
        });
      // Codex leaves same-project moves without an insertion anchor in place.
      for (const peer of order.slice(index + 1)) {
        yield* desktop.call("move_thread_to_project", nativeId, {
          threadId: peer,
          projectId: destinationId,
          beforeThreadId: nativeId,
        });
      }
    } else {
      const confirmation = yield* desktop
        .call("move_thread_to_project", nativeId, {
          threadId: nativeId,
          projectId: destinationId,
          ...(beforeNativeId ? { beforeThreadId: beforeNativeId } : {}),
        })
        .pipe(
          Effect.catchTags({
            CodexDesktopUnavailable: (error) =>
              error.moveConfirmation ? Effect.succeed(error.moveConfirmation) : Effect.fail(error),
          }),
        );
      if (confirmation)
        return {
          projectIds: [] as ProjectId[],
          threadIds: [] as ThreadId[],
          moveConfirmation: { threadId, projectId, ...confirmation },
        };
    }
    const desktopState = yield* readCodexDesktopState(homePath);
    if (codexDesktopSidebar(desktopState, homePath).threadProjectIds.get(nativeId) !== native.id)
      return yield* new MembershipError({
        message: "Codex desktop did not confirm the project assignment. T3 was not updated.",
      });
    if (!sameProject) {
      yield* request(client.raw, "thread/metadata/update", {
        threadId: nativeId,
        projectId: native.id,
      });
      const readback = yield* request(client.raw, "thread/read", {
        threadId: nativeId,
        includeTurns: false,
      }).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              thread: Schema.Struct({ projectId: Schema.NullOr(Schema.String) }),
            }),
          ),
        ),
      );
      if (readback.thread.projectId !== native.id)
        return yield* new MembershipError({
          message: "Codex did not confirm the chat move. T3 was not updated.",
        });
    }
    if (
      append &&
      codexDesktopSidebar(desktopState, homePath).projectThreadIds.get(native.id)?.at(-1) !==
        nativeId
    )
      return yield* new MembershipError({
        message: "Codex did not confirm the requested chat order. T3 was not updated.",
      });
    sidebarOrder = yield* pullCodexMembership(
      providerThread.providerInstanceId,
      client.raw,
      desktopState,
      homePath,
    );
    if (beforeThreadId) {
      const threadIds = sidebarOrder.threadIds.filter((id) => id !== threadId);
      const index = threadIds.indexOf(beforeThreadId);
      if (index < 0)
        return yield* new MembershipError({
          message: "Synchronize the Codex sidebar before positioning this chat.",
        });
      // Codex acknowledges sidebar edits before its state file is flushed.
      threadIds.splice(index, 0, threadId);
      sidebarOrder = { ...sidebarOrder, threadIds };
    }
  }
  yield* orchestrator.dispatch({
    type: "thread.metadata.update",
    commandId: CommandId.make(`project-membership:${yield* crypto.randomUUIDv4()}`),
    threadId,
    organizationProjectId: projectId,
  });
  return sidebarOrder;
});

const desktopProjectId = Effect.fn("desktopProjectId")(function* (
  nativeId: string,
  homePath: string,
) {
  const state = decodeDesktopSidebar(yield* readCodexDesktopState(homePath));
  if (Option.isSome(state)) {
    for (const [host, mapping] of Object.entries(
      state.value["app-server-project-id-by-legacy-project-id-by-host"],
    )) {
      if (
        host.startsWith("local:") &&
        normalizeProjectPathForComparison(host.slice(6)) ===
          normalizeProjectPathForComparison(homePath)
      ) {
        return Object.entries(mapping).find(([, id]) => id === nativeId)?.[0] ?? nativeId;
      }
    }
  }
  return nativeId;
});

export const organizeCodex = Effect.fn("organizeCodex")(function* (
  input: AgentSessionOrganizeInput,
) {
  if (input.action === "rename-project")
    return yield* new CodexDesktopUnavailable({ message: CODEX_PROJECT_RENAME_DISABLED_MESSAGE });
  if (input.action === "move-thread")
    return yield* moveCodexMembership(input.threadId, input.projectId, input.beforeThreadId);
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;
  if (input.action === "rename-thread") {
    const records = yield* orchestrator.getThreadRecords(input.threadId, ["providerThreads"]);
    const native =
      records.providerThreads.find(
        (entry) => entry.id === records.thread.activeProviderThreadId && entry.driver === "codex",
      ) ??
      records.providerThreads.find(
        (entry) => entry.driver === "codex" && entry.nativeThreadRef !== null,
      );
    if (native?.nativeThreadRef?.nativeId) {
      const { desktop } = yield* connect(native.providerInstanceId);
      yield* desktop.call("set_thread_title", native.nativeThreadRef.nativeId, {
        threadId: native.nativeThreadRef.nativeId,
        title: input.title,
      });
    }
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`codex-rename:${yield* crypto.randomUUIDv4()}`),
      threadId: input.threadId,
      title: input.title,
    });
    return { projectIds: [] as ProjectId[], threadIds: [] as ThreadId[] };
  }
  const instanceId =
    input.providerInstanceId ??
    ProviderInstanceId.make(
      Object.entries(settings.providerInstances).find(
        ([, instance]) => instance.driver === "codex" && instance.enabled !== false,
      )?.[0] ?? "codex",
    );
  if (
    input.providerInstanceId &&
    (settings.providerInstances[instanceId]?.driver !== "codex" ||
      settings.providerInstances[instanceId]?.enabled === false)
  )
    return yield* new MembershipError({ message: "The selected Codex provider is unavailable." });
  const { client, desktop, homePath } = yield* connect(instanceId);
  yield* desktop.requireTool("list_projects");
  const nativeProjects = yield* readCodexProjects(client.raw);
  const findProject = Effect.fn("organizeCodex.findProject")(function* (id: ProjectId) {
    const local = yield* projects.getById(id);
    if (Option.isNone(local) || local.value.deletedAt !== null)
      return yield* new MembershipError({ message: "The project no longer exists." });
    const native =
      nativeProjects.find((entry) => entry.metadata?.["t3code.projectId"] === id) ??
      nativeProjects.find((entry) =>
        entry.roots.some(
          (root) =>
            normalizeProjectPathForComparison(root.path) ===
            normalizeProjectPathForComparison(local.value.workspaceRoot),
        ),
      );
    return native;
  });
  {
    const orderedProjects = yield* Effect.forEach(input.projectIds, findProject);
    const ids = yield* Effect.forEach(
      orderedProjects.flatMap((native) => (native ? [native] : [])),
      (native) => desktopProjectId(native.id, homePath),
    );
    if (ids.length === 0)
      return yield* new MembershipError({
        message: "Synchronize projects from Codex before organizing them in T3.",
      });
    const owners = yield* readCodexThreadOwners(instanceId);
    const caller = owners.keys().next().value;
    if (!caller)
      return yield* new MembershipError({
        message: "Synchronize a Codex chat before organizing projects in T3.",
      });
    yield* desktop.call("reorder_sidebar_projects", caller, { projectIds: ids });
  }
  const order = yield* pullCodexMembership(
    instanceId,
    client.raw,
    yield* readCodexDesktopState(homePath),
    homePath,
  );
  if (input.action === "reorder-projects") {
    const confirmed = [...new Set(input.projectIds)].filter((id) => order.projectIds.includes(id));
    const included = new Set(confirmed);
    let index = 0;
    return {
      ...order,
      projectIds: order.projectIds.map((id) => (included.has(id) ? confirmed[index++]! : id)),
    };
  }
  return order;
});
