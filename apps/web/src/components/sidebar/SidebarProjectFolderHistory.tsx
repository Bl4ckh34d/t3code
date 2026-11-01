import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { useEffect, useEffectEvent } from "react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { olderSettledThreads } from "../../state/threads";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";

function useRemainingHistory(
  group: SidebarProjectSnapshot,
  threads: ReadonlyArray<EnvironmentThreadShell>,
) {
  const older = useAtomValue(olderSettledThreads.olderSettledAtom(group.environmentId));
  const projectIds = group.memberProjectRefs.map((ref) => ref.projectId);
  const count = projectIds.reduce((sum, id) => sum + (older?.counts.get(id) ?? 0), 0);
  const loaded =
    older === null
      ? 0
      : threads.filter(
          (thread) =>
            thread.source.settledAt !== null &&
            DateTime.toEpochMillis(thread.source.settledAt) < older.beforeMs,
        ).length;
  return { remaining: Math.max(0, count - loaded), projectIds };
}

export function SidebarProjectHistoryLoader({
  group,
  threads,
  visibleCount,
  expanded,
}: {
  readonly group: SidebarProjectSnapshot;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly visibleCount: number;
  readonly expanded: boolean;
}) {
  const { remaining, projectIds } = useRemainingHistory(group, threads);
  const shelf = useOlderSettledShelf({
    scopes: [{ environmentId: group.environmentId, projectIds }],
    expanded: expanded || threads.length > 0,
    visibleCount: Math.min(visibleCount, threads.length + remaining),
  });
  useOlderSettledShelfGrowth(shelf, threads.filter(shelf.isListed));
  const retry = useEffectEvent((requestedCount: number) => {
    if (requestedCount > 25) shelf.retry();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new history request retries a failed metadata page
  useEffect(() => {
    retry(visibleCount);
  }, [visibleCount]);
  return null;
}

export function SidebarProjectFolderHistory({
  group,
  threads,
  onShowMore,
}: {
  readonly group: SidebarProjectSnapshot;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onShowMore: () => void;
}) {
  const { remaining } = useRemainingHistory(group, threads);
  if (remaining === 0) return null;
  return (
    <li className="list-none">
      <button
        type="button"
        tabIndex={-1}
        onClick={onShowMore}
        className="flex h-9 w-full cursor-pointer items-center rounded-md pl-12 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover disabled:cursor-default"
      >
        {`Show ${Math.min(remaining, 25)} older chats`}
      </button>
    </li>
  );
}
