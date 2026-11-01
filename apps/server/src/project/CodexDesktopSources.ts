import type { CodexDesktopHistoryContext, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { connect } from "./CodexProjectMembership.ts";

const Projects = Schema.fromJsonString(
  Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        projectId: Schema.String,
        projectKind: Schema.String,
        label: Schema.String,
        path: Schema.optionalKey(Schema.NullOr(Schema.String)),
        hostId: Schema.optionalKey(Schema.NullOr(Schema.String)),
        hostDisplayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);
const Threads = Schema.fromJsonString(
  Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        threadId: Schema.optionalKey(Schema.String),
        projectId: Schema.NullOr(Schema.String),
      }),
    ),
    nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);
const State = Schema.fromJsonString(
  Schema.Struct({
    "codex-managed-remote-connections": Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          hostId: Schema.String,
          alias: Schema.NullOr(Schema.String),
          displayName: Schema.String,
        }),
      ),
    ),
  }),
);

class DesktopSourcesError extends Schema.TaggedError<DesktopSourcesError>()(
  "CodexDesktopSourcesError",
  {
    message: Schema.String,
  },
) {}

export const readCodexDesktopSources = Effect.fn("readCodexDesktopSources")(function* (
  instanceId: ProviderInstanceId,
) {
  const { client, desktop, desktopConfigured, homePath } = yield* connect(instanceId);
  if (!desktopConfigured) return [] as CodexDesktopHistoryContext[];
  const callers = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
  let caller: string | undefined;
  for (const archived of [false, true]) {
    const page = yield* client.raw
      .request("thread/list", { archived, modelProviders: [], limit: 1 })
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(callers)));
    caller = page.data[0]?.id;
    if (caller) break;
  }
  if (caller === undefined) return [] as CodexDesktopHistoryContext[];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const state = yield* fs
    .readFileString(path.join(homePath, ".codex-global-state.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(State)));
  const managed = new Map(
    (state["codex-managed-remote-connections"] ?? []).map((host) => [host.hostId, host]),
  );
  const read = (name: string, args: Record<string, unknown>) =>
    desktop
      .read(name, caller, args)
      .pipe(
        Effect.map(
          (result) => result.contentItems?.find((item) => item.text !== undefined)?.text ?? "",
        ),
      );
  const listed = yield* read("list_projects", {}).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Projects)),
  );
  const sources = new Map<string, CodexDesktopHistoryContext>();
  for (const project of listed.projects) {
    if (project.projectKind !== "local" && project.projectKind !== "remote") continue;
    if (!project.path)
      return yield* new DesktopSourcesError({
        message: `Codex project ${project.projectId} has no workspace path.`,
      });
    const hostId = project.hostId ?? "local";
    const host = managed.get(hostId);
    const source = sources.get(hostId) ?? {
      providerInstanceId: instanceId,
      hostId,
      label: project.hostDisplayName ?? host?.displayName ?? "Local Codex",
      sshAlias: host?.alias ?? null,
      projects: [],
      assignments: [],
    };
    sources.set(hostId, {
      ...source,
      projects: [
        ...source.projects,
        {
          id: project.projectId,
          title: project.label,
          workspaceRoot: project.path,
        },
      ],
    });
  }
  const result: CodexDesktopHistoryContext[] = [];
  for (const source of sources.values()) {
    const assignments = new Map<string, string | null>();
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = yield* read("list_threads", {
          mode: "history",
          source: "codex",
          hostId: source.hostId,
          archived,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Threads)));
        for (const thread of page.threads) {
          const id = thread.id ?? thread.threadId;
          if (id !== undefined) assignments.set(id, thread.projectId);
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor))
          return yield* new DesktopSourcesError({
            message: "Codex desktop repeated a history cursor.",
          });
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    result.push({
      ...source,
      assignments: [...assignments].map(([threadId, projectId]) => ({ threadId, projectId })),
    });
  }
  return result;
});
