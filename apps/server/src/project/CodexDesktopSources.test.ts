import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import { vi } from "vite-plus/test";
import { desktopBridge } from "./CodexDesktopBridge.ts";
import { readCodexDesktopSources } from "./CodexDesktopSources.ts";

const stubs = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("./CodexProjectMembership.ts", async (importOriginal) => {
  const { pendingCodexMembership } =
    await importOriginal<typeof import("./CodexProjectMembership.ts")>();
  return { connect: () => stubs.connect(), pendingCodexMembership };
});

it.effect(
  "reads every connected Codex host and keeps desktop project membership across pages",
  () =>
    Effect.gen(function* () {
      stubs.connect.mockReset();
      const desktop = desktopBridge((method, value) => {
        if (method === "tools/list")
          return Effect.succeed({
            tools: ["list_projects", "list_threads"].map((name) => ({
              name,
              namespace: "codex_app",
            })),
          });
        const call = value as {
          threadId: string;
          tool: string;
          arguments: { hostId: string; archived: boolean; cursor?: string };
        };
        expect(call.threadId).toBe("caller");
        const result =
          call?.tool === "list_projects"
            ? {
                projects: [
                  { projectId: "scratch", projectKind: "scratch", label: "Scratch" },
                  {
                    projectId: "local-project",
                    projectKind: "local",
                    label: "Local",
                    path: "/local",
                    hostId: "local",
                  },
                  {
                    projectId: "remote-project",
                    projectKind: "remote",
                    label: "Server",
                    path: "/server",
                    hostId: "ssh:server",
                  },
                ],
              }
            : {
                threads: call.arguments.archived
                  ? []
                  : [
                      {
                        id: call.arguments.cursor ? "older" : "recent",
                        projectId:
                          call.arguments.hostId === "local"
                            ? call.arguments.cursor
                              ? "local-project"
                              : null
                            : "remote-project",
                      },
                    ],
                nextCursor: call.arguments.archived || call.arguments.cursor ? null : "older",
              };
        return Effect.succeed(
          method === "tools/list"
            ? {
                tools: ["list_projects", "list_threads"].map((name) => ({
                  name,
                  namespace: "codex_app",
                })),
              }
            : { success: true, contentItems: [{ text: JSON.stringify(result) }] },
        );
      });
      stubs.connect.mockReturnValue(
        Effect.succeed({
          desktop,
          desktopConfigured: true,
          homePath: "/isolated/codex",
          client: { raw: { request: () => Effect.succeed({ data: [{ id: "caller" }] }) } },
        }),
      );
      const sources = yield* readCodexDesktopSources(ProviderInstanceId.make("codex"));
      expect(sources).toMatchObject([
        {
          hostId: "local",
          sshAlias: null,
          projects: [{ id: "local-project" }],
          assignments: [
            { threadId: "recent", projectId: "local-project" },
            { threadId: "older", projectId: null },
          ],
        },
        {
          hostId: "ssh:server",
          sshAlias: "server",
          projects: [{ id: "remote-project" }],
          assignments: [{ threadId: "recent", projectId: "remote-project" }, { threadId: "older" }],
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          Layer.succeed(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: () =>
                Effect.succeed(
                  JSON.stringify({
                    "codex-managed-remote-connections": [
                      { hostId: "ssh:server", alias: "server", displayName: "Server" },
                    ],
                    "app-server-project-id-by-legacy-project-id-by-host": {
                      "local:/isolated/codex": { "local-project": "native-project" },
                    },
                    "app-server-projects-migration-by-host": {
                      "local:/isolated/codex": {
                        threadAssignmentsMigrated: false,
                        pendingThreadAssignmentIds: ["recent", "older"],
                      },
                    },
                    "thread-project-assignments": {
                      recent: { projectKind: "local", projectId: "local-project" },
                    },
                    "projectless-thread-ids": ["older"],
                  }),
                ),
            }),
          ),
        ),
      ),
    ),
);
