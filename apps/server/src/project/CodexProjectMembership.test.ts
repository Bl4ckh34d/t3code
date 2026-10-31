import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  pendingCodexMembership,
  readCodexProjects,
  reconcileName,
} from "./CodexProjectMembership.ts";

it.effect("reads all project pages and rejects a repeated cursor", () =>
  Effect.gen(function* () {
    const project = (id: string) => ({ id, name: id, roots: [{ path: "/repo" }] });
    const request = (_method: string, params: unknown) =>
      Effect.succeed(
        (params as { cursor?: string }).cursor === undefined
          ? { data: [project("first")], nextCursor: "page2" }
          : { data: [project("second")], nextCursor: null },
      );
    expect((yield* readCodexProjects({ request })).map((entry) => entry.id)).toEqual([
      "first",
      "second",
    ]);
    const result = yield* Effect.result(
      readCodexProjects({
        request: () => Effect.succeed({ data: [], nextCursor: "repeat" }),
      }),
    );
    expect(result._tag).toBe("Failure");
  }),
);

it("uses only pending desktop assignments from the matching Codex home", () => {
  const state = {
    "app-server-project-id-by-legacy-project-id-by-host": {
      "local:/home/codex": { legacy: "native" },
    },
    "app-server-projects-migration-by-host": {
      "local:/home/codex": {
        threadAssignmentsMigrated: false,
        pendingThreadAssignmentIds: ["pending", "unassigned", "remote"],
      },
    },
    "thread-project-assignments": {
      pending: { projectKind: "local", projectId: "legacy" },
      finished: { projectKind: "local", projectId: "legacy" },
      remote: { projectKind: "remote", projectId: "legacy" },
    },
    "projectless-thread-ids": ["unassigned"],
  };
  expect([...pendingCodexMembership(state, "/home/codex")]).toEqual([
    ["pending", "native"],
    ["unassigned", null],
  ]);
  expect(pendingCodexMembership(state, "/different/home").size).toBe(0);
  expect(pendingCodexMembership({}, "/home/codex").size).toBe(0);
  state["app-server-projects-migration-by-host"]["local:/home/codex"].threadAssignmentsMigrated =
    true;
  expect(pendingCodexMembership(state, "/home/codex").size).toBe(0);
});

it("reconciles one-sided renames and preserves conflicting names", () => {
  expect(reconcileName("Old", "Codex", "Old")).toEqual({ title: "Codex", conflict: false });
  expect(reconcileName("T3", "Old", "Old")).toEqual({ title: "T3", conflict: false });
  expect(reconcileName("T3", "Codex", "Old").conflict).toBe(true);
  expect(reconcileName("Same", "Same", "Old").conflict).toBe(false);
  expect(reconcileName("Initial", "Codex").title).toBe("Codex");
});
