import { type PointerEvent as ReactPointerEvent } from "react";
import { type SensorProps } from "@dnd-kit/core";
import { getOwnerDocument, getWindow } from "@dnd-kit/utilities";
import "./Sidebar.drag.css";

export function createSidebarPointerFeedback(container: Element, source: Element) {
  let target: Element | null = null;
  const update = (next: { rowId: string; placement: "before" | "after" | "inside" } | null) => {
    target?.removeAttribute("data-sidebar-drop-placement");
    target = next
      ? container.querySelector(`[data-sidebar-row="${CSS.escape(next.rowId)}"]`)
      : null;
    if (next) target?.setAttribute("data-sidebar-drop-placement", next.placement);
  };
  return {
    start: () => {
      container.classList.add("sidebar-pointer-dragging");
      source.setAttribute("data-sidebar-drag-source", "true");
    },
    update,
    clear: () => {
      update(null);
      container.classList.remove("sidebar-pointer-dragging");
      source.removeAttribute("data-sidebar-drag-source");
    },
  };
}

export function sidebarPointerDropTarget(container: Element, point: { x: number; y: number }) {
  const row = container.ownerDocument
    .elementFromPoint(point.x, point.y)
    ?.closest<HTMLElement>("[data-sidebar-row]");
  if (!row || !container.contains(row) || !row.dataset.sidebarRow) return null;
  const bounds = row.getBoundingClientRect();
  return {
    rowId: row.dataset.sidebarRow,
    parentId: row.dataset.sidebarParent,
    placement: point.y < bounds.top + bounds.height / 2 ? ("before" as const) : ("after" as const),
  };
}

type Options = {
  distance: number;
  onAttach: (sensor: SidebarPointerSensor) => void;
  onFinish: (started: boolean) => void;
  /** Return true to claim the move and hide this position from sorting. */
  onMove?: (point: { x: number; y: number }) => boolean;
  /** Return true to consume the release and cancel sorting. */
  onDrop?: (point: { x: number; y: number }) => boolean;
};

export class SidebarPointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: ReactPointerEvent) =>
        nativeEvent.isPrimary && nativeEvent.button === 0,
    },
  ];
  autoScrollEnabled = true;
  private phase: "pending" | "dragging" | "finished" = "pending";
  private readonly pointer: PointerEvent;
  private readonly document: Document;
  private readonly window: Window;

  constructor(private readonly props: Omit<SensorProps<Options>, "activeNode" | "context">) {
    this.pointer = props.event as PointerEvent;
    this.document = getOwnerDocument(this.pointer.target);
    this.window = getWindow(this.pointer.target);
    this.document.addEventListener("pointermove", this.move, { passive: false, capture: true });
    this.document.addEventListener("pointerup", this.end, { capture: true });
    this.document.addEventListener("pointercancel", this.pointerCancel, { capture: true });
    this.document.addEventListener("keydown", this.keydown, { capture: true });
    this.document.addEventListener("visibilitychange", this.visibilityChange);
    this.window.addEventListener("blur", this.cancel);
    this.window.addEventListener("pagehide", this.cancel);
    this.window.addEventListener("resize", this.cancel);
    this.document.addEventListener("dragstart", this.preventDefault);
    this.document.addEventListener("contextmenu", this.preventDefault);
    props.options.onAttach(this);
    props.onPending(props.active, { distance: props.options.distance }, this.coordinates());
  }

  private coordinates = () => ({ x: this.pointer.clientX, y: this.pointer.clientY });
  private preventDefault = (event: Event) => event.preventDefault();
  private clearClickSuppression = () => {
    this.document.removeEventListener("click", this.suppressClick, { capture: true });
    this.document.removeEventListener("pointerdown", this.clearClickSuppression, { capture: true });
  };
  private suppressClick = (event: Event) => {
    event.stopPropagation();
    this.clearClickSuppression();
  };
  private clearSelection = () => this.document.getSelection()?.removeAllRanges();

  private move = (event: PointerEvent) => {
    if (this.phase === "finished" || event.pointerId !== this.pointer.pointerId) return;
    const coordinates = { x: event.clientX, y: event.clientY };
    // Desktop may report buttons=0 before pointerup; drop active context drags before cancelling sort.
    if ((event.buttons & 1) === 0) {
      if (this.phase === "dragging") this.props.options.onDrop?.(coordinates);
      return this.cancel();
    }
    if (this.phase === "pending") {
      const offset = {
        x: event.clientX - this.pointer.clientX,
        y: event.clientY - this.pointer.clientY,
      };
      if (Math.hypot(offset.x, offset.y) <= this.props.options.distance) {
        this.props.onPending(
          this.props.active,
          { distance: this.props.options.distance },
          this.coordinates(),
          offset,
        );
        return;
      }
      this.phase = "dragging";
      this.document.addEventListener("click", this.suppressClick, { capture: true });
      this.document.addEventListener("selectionchange", this.clearSelection);
      this.clearSelection();
      this.props.onStart(this.coordinates());
    }
    if (this.phase === "dragging") {
      if (event.cancelable) event.preventDefault();
      if (this.props.options.onMove?.(coordinates) === true) return;
      this.props.onMove(coordinates);
    }
  };

  private end = (event: PointerEvent) => {
    if (event.pointerId !== this.pointer.pointerId) return;
    const dropped =
      this.phase === "dragging" &&
      this.props.options.onDrop?.({ x: event.clientX, y: event.clientY }) === true;
    this.finish(dropped);
  };
  private pointerCancel = (event: PointerEvent) => {
    if (event.pointerId === this.pointer.pointerId) this.cancel();
  };
  private keydown = (event: KeyboardEvent) => {
    if (event.code === "Escape") this.cancel();
  };
  private visibilityChange = () => {
    if (this.document.hidden) this.cancel();
  };
  cancel = () => this.finish(true);

  private finish(cancelled: boolean) {
    if (this.phase === "finished") return;
    const aborted = this.phase === "pending";
    this.phase = "finished";
    this.document.removeEventListener("pointermove", this.move, { capture: true });
    this.document.removeEventListener("pointerup", this.end, { capture: true });
    this.document.removeEventListener("pointercancel", this.pointerCancel, { capture: true });
    this.document.removeEventListener("keydown", this.keydown, { capture: true });
    this.document.removeEventListener("visibilitychange", this.visibilityChange);
    this.window.removeEventListener("blur", this.cancel);
    this.window.removeEventListener("pagehide", this.cancel);
    this.window.removeEventListener("resize", this.cancel);
    this.document.removeEventListener("dragstart", this.preventDefault);
    this.document.removeEventListener("contextmenu", this.preventDefault);
    this.document.removeEventListener("selectionchange", this.clearSelection);
    // Suppress the eventual click after cancellation; a fresh pointerdown clears suppression after
    // out-of-document release.
    if (!aborted || cancelled) {
      this.document.addEventListener("click", this.suppressClick, { capture: true });
      this.document.addEventListener("pointerdown", this.clearClickSuppression, { capture: true });
    }
    try {
      // Release the preview before dnd-kit clears transforms; end/cancel events may be omitted before first
      // layout.
      this.props.options.onFinish(!aborted);
    } finally {
      if (aborted) this.props.onAbort(this.props.active);
      if (cancelled) this.props.onCancel();
      else this.props.onEnd();
    }
  }
}
