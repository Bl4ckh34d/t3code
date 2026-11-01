import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { renderCodexHistoryLinks } from "./SidebarCodexArchiveLink";

it("removes a machine's Codex history rows when its provider collapses", async () => {
  const local = EnvironmentId.make("local-machine");
  const remote = EnvironmentId.make("remote-machine");
  function HistoryRows({ open }: { open: readonly EnvironmentId[] }) {
    return (
      <ul>
        {[local, remote].flatMap((environmentId) => [
          <li key={environmentId}>{environmentId}</li>,
          ...(open.includes(environmentId)
            ? renderCodexHistoryLinks({
                environmentId,
                instanceId: "codex",
                showRecent: true,
              })
            : []),
        ])}
      </ul>
    );
  }
  await using screen = await render(<HistoryRows open={[local, remote]} />);
  await expect.element(screen.getByRole("treeitem", { name: "Archiv" })).toHaveLength(2);
  await screen.rerender(<HistoryRows open={[remote]} />);
  await expect.element(screen.getByRole("treeitem", { name: "Archiv" })).toHaveLength(1);
  expect(
    screen.container.querySelectorAll('[data-sidebar-parent="provider:local-machine:codex"]'),
  ).toHaveLength(0);
  await screen.rerender(<HistoryRows open={[]} />);
  await expect.element(screen.getByRole("treeitem")).not.toBeInTheDocument();
  await screen.rerender(<HistoryRows open={[local, remote]} />);
  await expect.element(screen.getByRole("treeitem", { name: "Archiv" })).toHaveLength(2);
  expect(
    screen.container.querySelectorAll('[data-sidebar-parent="provider:remote-machine:codex"]'),
  ).toHaveLength(2);
});
