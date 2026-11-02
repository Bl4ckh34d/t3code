import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  CodexDesktopUnavailable,
  desktopBridge,
  requestDesktopPipe,
} from "./CodexDesktopBridge.ts";

const State = Schema.fromJsonString(
  Schema.Struct({
    "local-projects": Schema.Record(
      Schema.String,
      Schema.Struct({ rootPaths: Schema.Array(Schema.String) }),
    ),
    "thread-project-assignments": Schema.Record(
      Schema.String,
      Schema.Struct({ projectKind: Schema.String }),
    ),
  }),
);
const Projects = Schema.fromJsonString(
  Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        projectId: Schema.String,
        projectKind: Schema.String,
        path: Schema.optionalKey(Schema.NullOr(Schema.String)),
        hostId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);
const decodeState = Schema.decodeUnknownEffect(State);
const decodeProjects = Schema.decodeUnknownEffect(Projects);

export const makeDesktopRequest = Effect.fn("CodexDesktopConnection.makeRequest")(function* (
  configuredPath: string,
  homePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const crypto = yield* Crypto.Crypto;
  let currentPath = configuredPath;
  const discover = Effect.fn("CodexDesktopConnection.discover")(function* () {
    const state = yield* fs.readFileString(path.join(homePath, ".codex-global-state.json")).pipe(
      Effect.flatMap(decodeState),
      Effect.mapError(
        () =>
          new CodexDesktopUnavailable({
            message:
              "Cannot verify the Codex desktop identity for this Codex home. Reconnect Codex desktop.",
          }),
      ),
    );
    const caller = Object.entries(state["thread-project-assignments"]).find(
      ([, assignment]) => assignment.projectKind === "local",
    )?.[0];
    if (!caller || Object.keys(state["local-projects"]).length === 0)
      return yield* new CodexDesktopUnavailable({
        message:
          "No local Codex project identity is available to reconnect safely. Reconnect Codex desktop.",
      });
    const names = yield* fs.readDirectory("\\\\.\\pipe\\").pipe(
      Effect.map((entries) =>
        entries.filter((name) => /^codex-app-tools-[a-zA-Z0-9-]+$/u.test(name)),
      ),
      Effect.mapError(
        () =>
          new CodexDesktopUnavailable({
            message: "Cannot discover the running Codex desktop connection.",
          }),
      ),
    );
    if (names.length > 32)
      return yield* new CodexDesktopUnavailable({
        message: "Too many Codex desktop connections to identify safely.",
      });
    const matches = yield* Effect.forEach(
      names,
      (name) => {
        const pipe = `\\\\.\\pipe\\${name}`;
        return desktopBridge(requestDesktopPipe(pipe))
          .read("list_projects", caller, {})
          .pipe(
            Effect.flatMap((result) =>
              decodeProjects(
                result.contentItems?.find((item) => item.text !== undefined)?.text ?? "",
              ),
            ),
            Effect.map((result) =>
              result.projects.some(
                (project) =>
                  project.projectKind === "local" &&
                  (project.hostId == null || project.hostId === "local") &&
                  project.path != null &&
                  state["local-projects"][project.projectId]?.rootPaths.some(
                    (root) =>
                      normalizeProjectPathForComparison(root) ===
                      normalizeProjectPathForComparison(project.path!),
                  ),
              )
                ? pipe
                : null,
            ),
            Effect.orElseSucceed(() => null),
          );
      },
      { concurrency: 4 },
    );
    const found = matches.filter((pipe) => pipe !== null);
    if (found.length !== 1)
      return yield* new CodexDesktopUnavailable({
        message:
          found.length > 1
            ? "Multiple Codex desktop connections match this Codex home. Close the duplicate instance and try again."
            : "No running Codex desktop matches this Codex home. Open that Codex desktop and try again.",
      });
    return found[0]!;
  });
  return Effect.fn("CodexDesktopConnection.request")(function* (method: string, params?: unknown) {
    return yield* requestDesktopPipe(currentPath)(method, params).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          // Only rediscover during the read-only handshake; a lost write acknowledgement must never replay a mutation.
          if (method !== "tools/list" || platform !== "win32") return yield* error;
          currentPath = yield* discover().pipe(Effect.provideService(Crypto.Crypto, crypto));
          return yield* requestDesktopPipe(currentPath)(method, params);
        }),
      ),
    );
  });
});
