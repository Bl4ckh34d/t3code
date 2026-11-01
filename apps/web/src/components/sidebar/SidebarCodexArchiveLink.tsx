import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArchiveIcon, ClockIcon } from "lucide-react";
import { sidebarProviderRowId } from "./SidebarProviderHeader";
import { refreshArchivedThreadsForEnvironment } from "../../lib/archivedThreadsState";

export function SidebarCodexArchiveLink(props: {
  environmentId: EnvironmentId;
  instanceId: string;
  emptyRecent?: boolean;
}) {
  const parent = sidebarProviderRowId(props.environmentId, props.instanceId);
  return props.emptyRecent ? (
    <li className="mt-2 list-none">
      <span
        role="treeitem"
        aria-label="Letzte, 0 Chats"
        aria-disabled="true"
        tabIndex={-1}
        data-sidebar-row={`${parent}:recent`}
        data-sidebar-parent={parent}
        className="flex h-8 items-center gap-2.5 ps-16 text-sm font-medium text-sidebar-muted-foreground"
      >
        <ClockIcon aria-hidden className="size-4 shrink-0" />
        Letzte<span className="text-xs">0</span>
      </span>
    </li>
  ) : (
    <li className="mt-2 list-none">
      <Link
        to="/settings/archived"
        search={{ machine: props.environmentId, archiveProvider: props.instanceId }}
        onClick={() => refreshArchivedThreadsForEnvironment(props.environmentId)}
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`${parent}:archive`}
        data-sidebar-parent={parent}
        className="flex h-8 w-full items-center gap-2.5 rounded-(--control-radius) ps-16 pe-(--sidebar-row-content-inset) text-sm font-medium text-sidebar-foreground/90 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ArchiveIcon aria-hidden className="size-4 shrink-0" />
        Archiv
      </Link>
    </li>
  );
}
