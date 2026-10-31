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

const readPendingCodexMembership = Effect.fn("readPendingCodexMembership")(function* (
  homePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const state = yield* fs
    .readFileString(path.join(homePath, ".codex-global-state.json"))
    .pipe(Effect.flatMap(decodeJson), Effect.option);
  return Option.isSome(state)
    ? pendingCodexMembership(state.value, homePath)
    : new Map<string, string | null>();
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

export function reconcileName(local: string, remote: string, baseline?: string) {
  if (local === remote) return { title: local, conflict: false };
  if (baseline === undefined || local === baseline) return { title: remote, conflict: false };
  if (remote === baseline) return { title: local, conflict: false };
  return { title: local, conflict: true };
}

export const synchronizeCodexMembership = Effect.fn("synchronizeCodexMembership")(function* (
  instanceId: ProviderInstanceId,
) {
  const crypto = yield* Crypto.Crypto;
  const { client, homePath } = yield* connect(instanceId);
  const pendingMembership = yield* readPendingCodexMembership(homePath);
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const nativeProjects = yield* readCodexProjects(client.raw);
  const mapping = new Map<string, ProjectId>();
  let mappingErrors = 0;
  for (const native of nativeProjects) {
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
        const name = reconcileName(
          local.value.title,
          native.name,
          native.metadata?.["t3code.syncedTitle"],
        );
        if (name.conflict) {
          mappingErrors++;
          return;
        }
        if (name.title !== local.value.title)
          yield* projects.update({
            commandId: CommandId.make(`codex-project-name:${yield* crypto.randomUUIDv4()}`),
            projectId: local.value.id,
            title: name.title,
          });
        if (name.title !== native.name)
          yield* request(client.raw, "project/update", { projectId: native.id, name: name.title });
        if (linkedId !== local.value.id || native.metadata?.["t3code.syncedTitle"] !== name.title)
          yield* request(client.raw, "project/update", {
            projectId: native.id,
            metadata: {
              ...native.metadata,
              "t3code.projectId": local.value.id,
              "t3code.syncedTitle": name.title,
            },
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
  let updated = 0;
  for (const archived of [false, true]) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = yield* decodeThreadPage(
        yield* request(client.raw, "thread/list", {
          limit: 100,
          archived,
          sourceKinds: CODEX_SYNC_THREAD_SOURCES,
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const native of page.data) {
        let nativeProjectId = native.projectId;
        const pendingProjectId = pendingMembership.get(native.id);
        if (nativeProjectId === null && pendingProjectId !== undefined) {
          // Desktop can have migrated its project IDs but not thread membership.
          // Read that pending migration only; all writes go through Codex's API.
          yield* request(client.raw, "thread/metadata/update", {
            threadId: native.id,
            projectId: pendingProjectId ?? "",
          });
          nativeProjectId = pendingProjectId;
        }
        const target = nativeProjectId === null ? null : mapping.get(nativeProjectId);
        if (target === undefined) continue;
        for (const threadId of owners.get(native.id) ?? []) {
          const records = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
          if (Option.isNone(records) || records.value.thread.deletedAt !== null) continue;
          const nativeName =
            native.name?.trim() ||
            records.value.thread.codexSyncedTitle ||
            records.value.thread.title;
          const name = nativeName
            ? reconcileName(
                records.value.thread.title,
                nativeName,
                records.value.thread.codexSyncedTitle,
              )
            : null;
          if (name?.conflict) {
            mappingErrors++;
            continue;
          }
          if (name && name.title !== nativeName)
            yield* request(client.raw, "thread/name/set", {
              threadId: native.id,
              name: name.title,
            });
          if (
            (records.value.thread.organizationProjectId ?? null) === target &&
            (!name ||
              (records.value.thread.title === name.title &&
                records.value.thread.codexSyncedTitle === name.title))
          )
            continue;
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`codex-membership:${yield* crypto.randomUUIDv4()}`),
            threadId,
            organizationProjectId: target,
            expectedTitle: records.value.thread.title,
            ...(name ? { title: name.title, codexSyncedTitle: name.title } : {}),
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
  return updated;
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
