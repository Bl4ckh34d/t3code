import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { resolveCodexThreadProject } from "./CodexThreadProject.ts";

it.effect("rejects ambiguous project roots and repeated cursors without creating a project", () =>
  Effect.gen(function* () {
    const project = { id: "selected", title: "Selected", workspaceRoot: "/fixtures/a" };
    for (const repeatedCursor of [false, true]) {
      let calls = 0;
      const result = yield* resolveCodexThreadProject(
        (method) =>
          Effect.sync(() => {
            expect(method).toBe("project/list");
            calls++;
            return repeatedCursor
              ? { data: [], nextCursor: "same" }
              : { data: ["one", "two"].map((id) => ({ id, roots: [{ path: "/fixtures/a" }] })) };
          }),
        project,
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(calls).toBe(repeatedCursor ? 2 : 1);
    }
  }),
);

it.effect(
  "resolves the selected project independently of a worktree cwd and pages through Codex projects",
  () =>
    Effect.gen(function* () {
      const project = { id: "t3-selected", title: "Selected", workspaceRoot: "C:/fixtures/a" };
      const request = (method: string, params: Record<string, unknown>) =>
        Effect.sync(() => {
          expect(method).toBe("project/list");
          return params.cursor === "next"
            ? {
                data: [{ id: "codex-a", roots: [{ path: "c:\\fixtures\\a" }], metadata: {} }],
                nextCursor: null,
              }
            : {
                data: [{ id: "codex-b", roots: [{ path: "C:/fixtures/b" }], metadata: {} }],
                nextCursor: "next",
              };
        });
      expect(yield* resolveCodexThreadProject(request, project)).toBe("codex-a");
    }),
);

it.effect(
  "creates a missing Codex project idempotently and leaves an explicit projectless chat unassigned",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const request = (method: string, params: Record<string, unknown>) =>
        Effect.sync(() => {
          calls.push(method);
          if (method === "project/list") return { data: [], nextCursor: null };
          expect(params).toMatchObject({
            name: "Selected",
            roots: [{ path: "/fixtures/a" }],
            idempotencyKey: "t3-project:t3-selected",
            metadata: { "t3code.projectId": "t3-selected" },
          });
          return { project: { id: "codex-created" } };
        });
      expect(yield* resolveCodexThreadProject(request, undefined)).toBeUndefined();
      expect(calls).toEqual([]);
      expect(
        yield* resolveCodexThreadProject(request, {
          id: "t3-selected",
          title: "Selected",
          workspaceRoot: "/fixtures/a",
        }),
      ).toBe("codex-created");
      expect(calls).toEqual(["project/list", "project/create"]);
    }),
);
