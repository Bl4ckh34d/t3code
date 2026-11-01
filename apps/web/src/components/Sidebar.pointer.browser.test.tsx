import type { SensorProps } from "@dnd-kit/core";
import { describe, expect, it, vi } from "vite-plus/test";
import { fakeTimers, render } from "../../test/render";
import {
  SidebarPointerSensor,
  sidebarPointerDropTarget,
  createSidebarPointerFeedback,
} from "./Sidebar.pointer";

const sensors: SidebarPointerSensor[] = [];

function pointer(type: string, values: PointerEventInit = {}) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    buttons: 1,
    ...values,
  });
}

function gesture(
  extraOptions: Partial<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]> = {},
) {
  const callbacks = {
    onStart: vi.fn(),
    onMove: vi.fn(),
    onEnd: vi.fn(),
    onCancel: vi.fn(),
    onAbort: vi.fn(),
    onPending: vi.fn(),
  };
  const onFinish = vi.fn();
  const props = {
    active: "thread",
    event: pointer("pointerdown"),
    options: { distance: 6, onAttach: vi.fn(), onFinish, ...extraOptions },
    ...callbacks,
  } as unknown as SensorProps<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]>;
  const sensor = new SidebarPointerSensor(props);
  sensors.push(sensor);
  return { sensor, onFinish, ...callbacks };
}

function setup() {
  const stack = new DisposableStack();
  stack.use(fakeTimers());
  stack.defer(() => {
    for (const sensor of sensors.splice(0)) sensor.cancel();
    // Cancelled sensors keep suppressing clicks on the shared document until the next press.
    document.dispatchEvent(pointer("pointerdown"));
    vi.runAllTimers();
  });
  return stack;
}

describe("sidebar pointer lifecycle", () => {
  it("resolves a folder or chat at release without HTML dragover events", async () => {
    await using screen = await render(
      <ul role="tree" aria-label="Fixture sidebar">
        <li>
          <button role="treeitem" data-sidebar-row="folder:fixture:b" style={{ height: 40 }}>
            Target folder
          </button>
        </li>
        <li>
          <div
            role="treeitem"
            data-sidebar-row="fixture:chat"
            data-sidebar-parent="folder:fixture:b"
            style={{ height: 40 }}
          >
            Target chat
          </div>
        </li>
      </ul>,
      // A DOM hit-test fixture, with no application navigation.
      { router: false },
    );
    const tree = screen.getByRole("tree").element();
    const folder = screen.getByRole("treeitem", { name: "Target folder" }).element();
    const chat = screen.getByRole("treeitem", { name: "Target chat" }).element();
    const folderBounds = folder.getBoundingClientRect();
    const chatBounds = chat.getBoundingClientRect();
    expect(
      sidebarPointerDropTarget(tree, { x: folderBounds.left + 5, y: folderBounds.top + 5 }),
    ).toEqual({ rowId: "folder:fixture:b", parentId: undefined, placement: "before" });
    expect(
      sidebarPointerDropTarget(tree, { x: chatBounds.left + 5, y: chatBounds.bottom - 5 }),
    ).toEqual({ rowId: "fixture:chat", parentId: "folder:fixture:b", placement: "after" });
    expect(sidebarPointerDropTarget(tree, { x: -1, y: -1 })).toBeNull();
    const feedback = createSidebarPointerFeedback(tree, folder);
    feedback.start();
    expect(getComputedStyle(folder).opacity).toBe("0.45");
    feedback.update({ rowId: "fixture:chat", placement: "before" });
    expect(getComputedStyle(chat, "::before").borderTopWidth).toBe("2px");
    feedback.update({ rowId: "folder:fixture:b", placement: "inside" });
    expect(getComputedStyle(folder).boxShadow).not.toBe("none");
    feedback.clear();
    expect(getComputedStyle(folder).opacity).toBe("1");
    expect(getComputedStyle(folder).boxShadow).toBe("none");
    expect(chat.hasAttribute("data-sidebar-drop-placement")).toBe(false);
  });

  it("drops context when a zero-button move precedes pointerup", () => {
    using _environment = setup();
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove: (point) => point.x > 50, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));

    // Native desktop releases can report the released button on the final move.
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 94, clientY: 32 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 94, clientY: 32 }));
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 100, clientY: 40 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 94, y: 32 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);
  });

  // regression: #17373 a zero-button release outside a drop target must cancel, not reorder
  it("cancels a missed sidebar release without committing a reorder", () => {
    using _environment = setup();
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove: (point) => point.x > 50, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 30, clientY: 40 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 30, clientY: 40 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 30, y: 40 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);
  });
});
