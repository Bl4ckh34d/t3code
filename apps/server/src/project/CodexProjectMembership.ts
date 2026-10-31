import {
  CodexSettings,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
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

const NativeProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  roots: Schema.Array(Schema.Struct({ path: Schema.String })),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const ProjectPage = Schema.Struct({
  data: Schema.Array(NativeProject),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeProjectPage = Schema.decodeUnknownEffect(ProjectPage);
const decodeImportedProject = Schema.decodeUnknownEffect(Schema.Struct({ project: NativeProject }));
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
// Codex defaults to interactive sources, which omits historical exec chats.
export const CODEX_SYNC_THREAD_SOURCES = ["cli", "vscode", "exec", "appServer", "unknown"] as const;
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
      result.set(id, mapping[assignment.projectId]!);
  }
  return result;
}

const DesktopSidebar = Schema.Struct({
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
    for (const legacy of [
      ...(data["project-order"] ?? []),
      ...Object.keys(data["local-projects"]),
    ]) {
      const id = mapping[legacy];
      const project = data["local-projects"][legacy];
      if (!id || !project || projects.has(id)) continue;
      projects.set(id, project);
      projectIds.push(id);
      threadIds.push(...(data["sidebar-project-thread-orders"]?.[legacy]?.threadIds ?? []));
    }
  }
  return { projects, projectIds, threadIds: [...new Set(threadIds)] };
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
  return { ...connection, homePath: layout.sharedHomePath };
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
) {
  const crypto = yield* Crypto.Crypto;
  const pendingMembership = pendingCodexMembership(desktopState, homePath);
  const sidebar = codexDesktopSidebar(desktopState, homePath);
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const nativeProjects = yield* readCodexProjects(raw);
  const mapping = new Map<string, ProjectId>();
  let mappingErrors = 0;
  for (const entry of nativeProjects) {
    const desktop = sidebar.projects.get(entry.id);
    const native = desktop
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
  const listedThreadIds: string[] = [];
  let updated = 0;
  for (const archived of [false, true]) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = yield* decodeThreadPage(
        yield* request(raw, "thread/list", {
          limit: 100,
          archived,
          sortKey: "updated_at",
          sourceKinds: CODEX_SYNC_THREAD_SOURCES,
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const native of page.data) {
        listedThreadIds.push(native.id);
        let nativeProjectId = native.projectId;
        const pendingProjectId = pendingMembership.get(native.id);
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
  if (mappingErrors > 0)
    return yield* new MembershipError({
      message: `${mappingErrors} Codex projects could not be linked.`,
    });
  return {
    updated,
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
) {
  const { client, homePath } = yield* connect(instanceId);
  return yield* pullCodexMembership(
    instanceId,
    client.raw,
    yield* readCodexDesktopState(homePath),
    homePath,
  );
});

export const moveCodexMembership = Effect.fn("moveCodexMembership")(function* (
  threadId: ThreadId,
  projectId: ProjectId,
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
  for (const providerThread of preferred ? [preferred] : []) {
    if (!providerThread.nativeThreadRef) continue;
    const { client } = yield* connect(providerThread.providerInstanceId);
    const nativeProjects = yield* readCodexProjects(client.raw);
    let native =
      nativeProjects.find((entry) => entry.metadata?.["t3code.projectId"] === projectId) ??
      nativeProjects.find(
        (entry) =>
          entry.roots[0] !== undefined &&
          normalizeProjectPathForComparison(entry.roots[0].path) ===
            normalizeProjectPathForComparison(target.value.workspaceRoot),
      );
    if (!native) {
      const response = yield* request(client.raw, "project/import", {
        idempotencyKey: `t3:${projectId}`,
        name: target.value.title,
        roots: [{ path: target.value.workspaceRoot }],
        metadata: { "t3code.projectId": projectId },
      });
      native = (yield* decodeImportedProject(response)).project;
    }
    yield* request(client.raw, "thread/metadata/update", {
      threadId: providerThread.nativeThreadRef.nativeId,
      projectId: native.id,
    });
  }
  yield* orchestrator.dispatch({
    type: "thread.metadata.update",
    commandId: CommandId.make(`project-membership:${yield* crypto.randomUUIDv4()}`),
    threadId,
    organizationProjectId: projectId,
  });
});
