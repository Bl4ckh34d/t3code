import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import { useClientSettings } from "../hooks/useSettings";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { useSidebarThreads } from "./Sidebar";
import { useSidebarEnvironmentOrder } from "./sidebar/useSidebarEnvironmentOrder";

vi.mock("../hooks/useSettings", { spy: true });

it("retains device order across remount and includes newly connected machines", async () => {
  const ids = [EnvironmentId.make("sort-local"), EnvironmentId.make("sort-remote")];
  const key = "t3.sidebar.environment-order.v1";
  const previous = localStorage.getItem(key);
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    if (previous === null) localStorage.removeItem(key);
    else localStorage.setItem(key, previous);
  });
  localStorage.removeItem(key);
  function Devices({ added = false }: { added?: boolean }) {
    const order = useSidebarEnvironmentOrder(
      added ? [...ids, EnvironmentId.make("sort-new")] : ids,
    );
    return (
      <>
        <output>{order.ids.join(",")}</output>
        <button onClick={() => order.move(ids[1]!, ids[0]!, "before")}>Move device</button>
      </>
    );
  }
  await using screen = await render(<Devices />);
  await screen.getByRole("button", { name: "Move device" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("sort-remote,sort-local");
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(["sort-remote", "sort-local"]);
  await screen.rerender(<Devices key="remounted" added />);
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("sort-remote,sort-local,sort-new");
});
vi.mock("../state/olderSettledShelf", () => ({
  useOlderSettledShelf: () => ({
    isListed: () => true,
    unloadedCount: () => 0,
    loading: false,
    failed: false,
  }),
  useOlderSettledShelfGrowth: () => {},
  readUnloadedThreadCount: () => 0,
}));

it("keeps an older project's chats visible beyond another project's ten recent settled chats", async () => {
  vi.mocked(useClientSettings).mockImplementation((select) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
  );
  const environmentId = EnvironmentId.make("folder-history-test");
  const instanceId = ProviderInstanceId.make("codex");
  const projects = ["Recent", "Older project"].map((title) => ({
    id: ProjectId.make(title),
    environmentId,
    title,
    workspaceRoot: title === "Older project" ? "C:\\isolated\\Older project" : `/isolated/${title}`,
    repositoryIdentity: null,
    defaultModelSelection: { instanceId, model: "test" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  }));
  projects.push({
    ...projects[1]!,
    id: ProjectId.make("older-case-alias"),
    workspaceRoot: "c:\\isolated\\Older project",
    updatedAt: "2027-01-01T00:00:00.000Z",
  });
  const threads = Array.from({ length: 14 }, (_, index) =>
    makeThreadFixture({
      environmentId,
      id: ThreadId.make(`history-${index}`),
      projectId: projects[index < 10 ? 0 : 1]!.id,
      title: index < 10 ? `Recent ${index}` : `Older chat ${index - 9}`,
      settledOverride: "settled",
      settledAt: `2026-01-${String(31 - index).padStart(2, "0")}T00:00:00.000Z`,
    }),
  );
  const folderGroups = buildSidebarProjectSnapshots({
    projects,
    settings: { sidebarProjectGroupingMode: "separate", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: environmentId,
    resolveEnvironmentLabel: () => "Fixture",
  });
  const config = {
    environment: { environmentId, capabilities: {} },
  } as EnvironmentServerConfig;
  function ProjectFolders() {
    const sidebar = useSidebarThreads({
      projectScopeKey: null,
      scopedProjectKeys: null,
      serverConfigs: new Map([[environmentId, config]]),
      connectedEnvironmentIds: [environmentId],
      optimisticDrop: null,
      threads,
      delegatedUnderParent: new Set(),
      routeRowThreadKey: null,
      folderGroups,
      projectFolderOrder: [],
      keepEmptyFolders: () => true,
      environmentIds: [environmentId],
      providerEntriesByEnvironment: new Map(),
    });
    return (
      <ul>
        {sidebar.projectFolders?.flatMap((folder) =>
          folder.threads.map((thread) => <li key={thread.id}>{thread.title}</li>),
        )}
      </ul>
    );
  }
  await using screen = await render(<ProjectFolders />);
  await expect.element(screen.getByText("Older chat 1", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Older chat 4", { exact: true })).toBeVisible();
});
