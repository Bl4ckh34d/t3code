import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ArchivedShellSnapshot,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { ArchivedThreadsPanel } from "./ArchivedThreadsPanel";

const state = vi.hoisted(() => ({
  snapshots: [] as {
    environmentId: EnvironmentId;
    snapshot: OrchestrationV2ArchivedShellSnapshot;
  }[],
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({
    snapshots: state.snapshots,
    error: null,
    isLoading: false,
    refresh: () => {},
  }),
}));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({ unarchiveThread: vi.fn(), confirmAndDeleteThread: vi.fn() }),
}));
vi.mock("./SettingsScopeContext", async (original) => ({
  ...(await original<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: state.snapshots.map((entry) => entry.environmentId) },
    groups: [],
    environments: [],
  }),
}));

it("shows only the selected provider's archived chats and keeps the unfiltered archive available", async () => {
  const base = makeThreadProjectionFixture().thread;
  const thread = (id: string, providerInstanceId: string) => ({
    ...base,
    id: ThreadId.make(id),
    title: id,
    providerInstanceId: ProviderInstanceId.make(providerInstanceId),
    archivedAt: base.createdAt,
    latestRunId: null,
    activeRunId: null,
    status: "idle" as const,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
  });
  state.snapshots = [
    {
      environmentId: EnvironmentId.make("isolated"),
      snapshot: {
        schemaVersion: 1,
        snapshotSequence: 0,
        projects: [
          {
            id: ProjectId.make("project-test"),
            title: "Fixture",
            workspaceRoot: "/isolated",
            scripts: [],
            defaultModelSelection: null,
            createdAt: DateTime.formatIso(base.createdAt),
            updatedAt: DateTime.formatIso(base.updatedAt),
          },
        ],
        threads: [
          thread("Work historical", "codex-work"),
          thread("Personal historical", "codex-personal"),
        ],
      },
    },
  ];
  await using screen = await render(<ArchivedThreadsPanel />, {
    router: "/settings/archived?archiveProvider=codex-work",
  });
  await expect.element(screen.getByRole("heading", { name: "Work historical" })).toBeVisible();
  await expect
    .element(screen.getByRole("heading", { name: "Personal historical" }))
    .not.toBeInTheDocument();
  await screen.router!.navigate({ to: "/settings/archived", search: {} });
  await expect.element(screen.getByRole("heading", { name: "Personal historical" })).toBeVisible();
});
