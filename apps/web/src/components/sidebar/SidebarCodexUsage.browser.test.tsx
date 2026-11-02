import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { WeeklyUsageRing } from "./SidebarCodexUsage";
import "~/index.css";

it("shows weekly remaining quota instead of session usage and clears unavailable values", async () => {
  const usage = {
    checkedAt: "2026-11-02T00:00:00.000Z",
    windows: [
      { id: "primary", kind: "session" as const, label: "Session", usedPercent: 90 },
      { id: "secondary", kind: "weekly" as const, label: "Weekly", usedPercent: 33 },
    ],
  };
  await using screen = await render(<WeeklyUsageRing usage={usage} />);
  await expect.element(screen.getByRole("img", { name: "Wöchentlich · noch 67 %" })).toBeVisible();
  await screen.getByRole("img").hover();
  await expect.element(page.getByText("Wöchentlich · noch 67 %", { exact: true })).toBeVisible();
  await screen.rerender(
    <WeeklyUsageRing usage={{ ...usage, unavailable: { reason: "probeFailed" } }} />,
  );
  await expect
    .element(screen.getByRole("img", { name: "Wöchentlich · Kontingent unbekannt" }))
    .toBeVisible();
  await screen.rerender(
    <WeeklyUsageRing usage={{ ...usage, windows: [{ ...usage.windows[1]!, usedPercent: 100 }] }} />,
  );
  await expect.element(screen.getByRole("img", { name: "Wöchentlich · noch 0 %" })).toBeVisible();
});
