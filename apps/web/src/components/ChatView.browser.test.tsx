import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ProjectId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  fakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";
import "~/index.css";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

it("keeps a blocked move visible and checks approval without resubmitting the move", async () => {
  await page.viewport(1600, 1000);
  const source = threadWithHistory("move-approval-source", 1);
  const destination = {
    ...threadWithHistory("move-approval-target", 1),
    projectId: ProjectId.make("approval-target-project"),
  };
  using _environment = installFakeEnvironment([source, destination]);
  const connect = fakeDriver.connect;
  const actions: string[] = [];
  let movedInCodex = false;
  using _driver = vi.spyOn(fakeDriver, "connect").mockImplementation((...args) =>
    connect(...args).pipe(
      Effect.map((lease) => ({
        ...lease,
        session: {
          ...lease.session,
          client: new Proxy(lease.session.client, {
            get(target, key) {
              if (key !== WS_METHODS.agentSessionsOrganize) return Reflect.get(target, key);
              return (input: { action: string }) =>
                Effect.sync(() => {
                  actions.push(input.action);
                  if (input.action === "check-move" && !movedInCodex)
                    throw new Error("Codex still requires folder approval.");
                  return input.action === "move-thread"
                    ? {
                        projectIds: [],
                        threadIds: [],
                        moveConfirmation: {
                          threadId: source.id,
                          projectId: destination.projectId,
                          projectTitle: "Destination",
                          sourcePaths: ["/isolated/source"],
                        },
                      }
                    : { projectIds: [], threadIds: [] };
                });
            },
          }),
        },
      })),
    ),
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${source.id}`] }),
  );
  await router.load();
  // AppRoot owns the router and renders the actual sidebar/drop handlers.
  await using screen = await render(<AppRoot router={router} />, { router: false });
  await expect.element(screen.getByTestId("sidebar-row-folder").first()).toBeVisible();
  const sourceRow = document.querySelector(`[data-thread-item="${ENVIRONMENT_ID}:${source.id}"]`);
  const targetFolder = [
    ...document.querySelectorAll('[data-testid="sidebar-project-folder"]'),
  ].find((row) => row.textContent?.includes("Unassigned Codex chats"));
  expect(sourceRow).not.toBeNull();
  expect(targetFolder).toBeDefined();
  const transfer = new DataTransfer();
  sourceRow!.dispatchEvent(
    new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }),
  );
  targetFolder!.dispatchEvent(
    new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }),
  );
  targetFolder!.dispatchEvent(
    new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
  );
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Refresh assignment", exact: true }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(page.getByRole("alert").element().textContent).toContain(
    "Codex still requires folder approval",
  );
  expect(actions).toEqual(["move-thread", "check-move"]);
  await page.getByRole("button", { name: "Open chat in Codex", exact: true }).click();
  expect(actions.at(-1)).toBe("open-move-in-codex");
  movedInCodex = true;
  await page.getByRole("button", { name: "Refresh assignment", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(actions.filter((action) => action === "move-thread")).toHaveLength(1);
});

it("starts a new chat in the synchronized project instead of its import storage project", async () => {
  const thread = {
    ...threadWithHistory("imported-project", 1),
    projectId: ProjectId.make("codex-unassigned-history"),
    organizationProjectId: PROJECT_ID,
  };
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  // AppRoot owns the router.
  await using screen = await render(<AppRoot router={router} />, { router: false });
  const newThread = screen
    .getByRole("button", { name: /^New thread in (render|Unassigned Codex chats)$/ })
    .first();
  await expect.element(newThread).toBeVisible();
  expect(newThread.element().getAttribute("aria-label")).toBe("New thread in render");
  await newThread.click();
  await vi.waitFor(() => expect(router.state.location.pathname).toMatch(/^\/draft\//));
  const draftId = DraftId.make(router.state.location.pathname.slice("/draft/".length));
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.projectId).toBe(PROJECT_ID);
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});
