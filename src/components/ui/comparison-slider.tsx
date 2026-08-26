import { createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { Icon } from "@/components/ui/nav-icon";
import { chromeIconColor, chromeIconSize } from "@/config/map-config";

interface ComparisonSliderProps {
  position: number; // 0-100 percentage
  onPositionChange: (position: number) => void;
}

export function ComparisonSlider(props: ComparisonSliderProps): JSX.Element {
  let container!: HTMLDivElement;
  const [dragging, setDragging] = createSignal(false);

  function updatePosition(clientX: number) {
    const parent = container.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    props.onPositionChange(Math.max(0, Math.min(100, pct)));
  }

  createEffect(() => {
    if (!dragging()) return;

    function onMouseMove(e: MouseEvent) {
      e.preventDefault();
      updatePosition(e.clientX);
    }
    function onMouseUp() {
      setDragging(false);
    }
    function onTouchMove(e: TouchEvent) {
      e.preventDefault();
      updatePosition(e.touches[0].clientX);
    }
    function onTouchEnd() {
      setDragging(false);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);

    onCleanup(() => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    });
  });

  return (
    <div
      ref={container}
      class="absolute top-0 bottom-0 z-20"
      style={{ left: `${props.position}%`, transform: "translateX(-50%)" }}
    >
      <div
        class="h-full w-1 bg-white shadow-md cursor-ew-resize"
        onMouseDown={() => setDragging(true)}
        onTouchStart={() => setDragging(true)}
      />
      <div
        class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex h-8 w-8 cursor-ew-resize items-center justify-center rounded-full bg-white shadow-md"
        onMouseDown={() => setDragging(true)}
        onTouchStart={() => setDragging(true)}
      >
        {/* The shared chrome icon, so the handle takes the project's accent and
            size like every other chrome control — it was the last hardcoded
            inline SVG in the app. `arrows_outward` is a 2:1 horizontal arrow,
            which reads as the left/right drag this control offers. */}
        <Icon name="arrows_outward" size={chromeIconSize()} color={chromeIconColor()} />
      </div>
    </div>
  );
}
