import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const ProjectPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      roots: Schema.Array(Schema.Struct({ path: Schema.String })),
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const CreatedProject = Schema.Struct({ project: Schema.Struct({ id: Schema.String }) });
class CodexThreadProjectError extends Schema.TaggedError<CodexThreadProjectError>()(
  "CodexThreadProjectError",
  { message: Schema.String },
) {}

export const resolveCodexThreadProject = Effect.fn("CodexThreadProject.resolve")(function* <E, R>(
  request: (method: string, params: Record<string, unknown>) => Effect.Effect<unknown, E, R>,
  project:
    | { readonly id: string; readonly title: string; readonly workspaceRoot: string }
    | undefined,
) {
  if (project === undefined) return undefined;
  const nativeProjects: Array<(typeof ProjectPage.Type.data)[number]> = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = yield* request("project/list", { limit: 100, ...(cursor ? { cursor } : {}) }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ProjectPage)),
    );
    nativeProjects.push(...page.data);
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor))
      return yield* new CodexThreadProjectError({ message: "Codex repeated a project cursor." });
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const linked = nativeProjects.find(
    (entry) => entry.metadata?.["t3code.projectId"] === project.id,
  );
  if (linked) return linked.id;
  const matches = nativeProjects.filter((entry) =>
    entry.roots.some(
      (root) =>
        normalizeProjectPathForComparison(root.path) ===
        normalizeProjectPathForComparison(project.workspaceRoot),
    ),
  );
  if (matches.length > 1)
    return yield* new CodexThreadProjectError({
      message:
        "Multiple Codex projects match this workspace. Synchronize projects before creating the chat.",
    });
  if (matches[0]) return matches[0].id;
  const created = yield* request("project/create", {
    name: project.title,
    roots: [{ path: project.workspaceRoot }],
    metadata: { "t3code.projectId": project.id },
    idempotencyKey: `t3-project:${project.id}`,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CreatedProject)));
  return created.project.id;
});
