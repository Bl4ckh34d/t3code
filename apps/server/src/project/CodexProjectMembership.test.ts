import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  pendingCodexMembership,
  readCodexProjects,
  incomingCodexTitle,
  codexDesktopSidebar,
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

it("always takes Codex names and retains a title only when Codex has none", () => {
  expect(incomingCodexTitle("T3 rename", "Codex rename")).toBe("Codex rename");
  expect(incomingCodexTitle("T3 rename", "Old")).toBe("Old");
  expect(incomingCodexTitle("Existing", null)).toBe("Existing");
  expect(incomingCodexTitle("Existing", "  ")).toBe("Existing");
});

it("reads desktop project names and orders only for the matching local home", () => {
  const state = {
    "app-server-project-id-by-legacy-project-id-by-host": {
      "local:/home/codex": { a: "native-a", b: "native-b" },
    },
    "local-projects": {
      a: { name: "Renamed in desktop", rootPaths: ["/repo/a"] },
      b: { name: "Second", rootPaths: ["/repo/b"] },
    },
    "project-order": ["remote", "b", "a", "b"],
    "sidebar-project-thread-orders": {
      a: { threadIds: ["chat2", "chat1"], sortKey: "updated_at" },
      b: { threadIds: ["chat3"] },
    },
  };
  const sidebar = codexDesktopSidebar(state, "/home/codex");
  expect(sidebar.projectIds).toEqual(["native-b", "native-a"]);
  expect(sidebar.threadIds).toEqual(["chat3", "chat2", "chat1"]);
  expect(sidebar.projects.get("native-a")).toEqual({
    name: "Renamed in desktop",
    rootPaths: ["/repo/a"],
  });
  expect(codexDesktopSidebar(state, "/other/home").projectIds).toEqual([]);
  expect(codexDesktopSidebar({}, "/home/codex").projects.size).toBe(0);
});
