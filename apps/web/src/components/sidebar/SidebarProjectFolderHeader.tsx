import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, PinIcon, SquarePenIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { sidebarEnvironmentRowId } from "./SidebarEnvironmentHeader";

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const FOLDER_DOT_LABEL = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", done",
  working: ", working",
} as const;

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(
  group: Pick<SidebarProjectSnapshot, "environmentId" | "projectKey">,
) {
  return `folder:${group.environmentId}:${group.projectKey}`;
}

/**
 * A project folder in the boring sidebar. It reads like a shelf header: a trailing
 * count and chevron, with the count and a status dot only while it is closed, so a
 * closed folder still says when a hidden thread needs you.
 */
export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: {
  canDropThread?: boolean;
  onDragProjectStart?: React.DragEventHandler<HTMLButtonElement>;
  onDragProjectEnd?: React.DragEventHandler<HTMLButtonElement>;
  projectDragActive?: boolean;
  onDropThread?: (group: SidebarProjectSnapshot, placement?: "before" | "after") => void;
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onContextMenu: (group: SidebarProjectSnapshot, position: { x: number; y: number }) => void;
}) {
  const { group, collapsed, hiddenThreads } = props;
  const [dragOver, setDragOver] = useState(false);
  const [dropPlacement, setDropPlacement] = useState<"before" | "after">("before");
  const rowId = sidebarFolderRowId(group);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  return (
    <li
      data-testid="sidebar-project-folder"
      className={cn(
        "group/project-folder relative mt-2 list-none first:mt-0",
        dragOver &&
          props.canDropThread &&
          !props.projectDragActive &&
          "rounded-md ring-2 ring-primary",
      )}
      onDragOver={(event) => {
        if (props.canDropThread) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDragOver(true);
          if (props.projectDragActive) {
            const bounds = event.currentTarget.getBoundingClientRect();
            setDropPlacement(event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
          }
        }
      }}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        setDragOver(false);
      }}
      onDrop={(event) => {
        setDragOver(false);
        if (props.canDropThread) {
          event.preventDefault();
          props.onDropThread?.(group, props.projectDragActive ? dropPlacement : undefined);
        }
      }}
    >
      {dragOver && props.canDropThread && props.projectDragActive ? (
        <span
          aria-hidden
          data-testid="project-folder-insertion-line"
          className={cn(
            "pointer-events-none absolute inset-x-0 z-10 border-t-2 border-primary",
            dropPlacement === "before" ? "top-0" : "bottom-0",
          )}
        />
      ) : null}
      <button
        type="button"
        draggable={props.onDragProjectStart !== undefined}
        onDragStart={props.onDragProjectStart}
        onDragEnd={props.onDragProjectEnd}
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={rowId}
        data-sidebar-parent={sidebarEnvironmentRowId(group.environmentId)}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(group)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(group, { x: event.clientX, y: event.clientY });
        }}
        className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) pe-(--sidebar-row-content-inset) ps-7 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ProjectFavicon project={group} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {group.displayName}
        </span>
        {group.pinned ? (
          <PinIcon
            aria-label="Pinned project"
            className="size-3 shrink-0 text-sidebar-muted-foreground"
          />
        ) : null}
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{FOLDER_DOT_LABEL[dot]}</span>
          </span>
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/project-folder:invisible pointer-coarse:invisible">
            {hiddenThreads.length}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      {/* Sits over the count, which hides on hover, and left of the chevron. */}
      <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                data-sidebar-action-for={rowId}
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`New thread in ${group.displayName}`}
                onClick={() => props.onNewThread(group)}
              />
            }
          >
            <SquarePenIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup>New thread in {group.displayName}</TooltipPopup>
        </Tooltip>
      </span>
    </li>
  );
});
