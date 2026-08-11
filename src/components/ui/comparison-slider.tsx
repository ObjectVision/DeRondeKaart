import { useRef, useCallback, useEffect, useState } from "react";

interface ComparisonSliderProps {
  position: number; // 0-100 percentage
  onPositionChange: (position: number) => void;
}

export function ComparisonSlider({
  position,
  onPositionChange,
}: ComparisonSliderProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const updatePosition = useCallback(
    (clientX: number) => {
      const container = containerRef.current?.parentElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const pct = ((clientX - rect.left) / rect.width) * 100;
      onPositionChange(Math.max(0, Math.min(100, pct)));
    },
    [onPositionChange],
  );

  useEffect(() => {
    if (!dragging) return;

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

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [dragging, updatePosition]);

  return (
    <div
      ref={containerRef}
      className="absolute top-0 bottom-0 z-20"
      style={{ left: `${position}%`, transform: "translateX(-50%)" }}
    >
      <div className="h-full w-1 bg-white shadow-md cursor-ew-resize"
        onMouseDown={() => setDragging(true)}
        onTouchStart={() => setDragging(true)}
      />
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex h-8 w-8 cursor-ew-resize items-center justify-center rounded-full bg-white shadow-md"
        onMouseDown={() => setDragging(true)}
        onTouchStart={() => setDragging(true)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="size-4 text-gray-600">
          <path fillRule="evenodd" d="M6.28 5.22a.75.75 0 0 1 0 1.06L3.56 9.25H8a.75.75 0 0 1 0 1.5H3.56l2.72 2.97a.75.75 0 1 1-1.06 1.06l-4-4.25a.75.75 0 0 1 0-1.06l4-4.25a.75.75 0 0 1 1.06 0Zm7.44 0a.75.75 0 0 1 1.06 0l4 4.25a.75.75 0 0 1 0 1.06l-4 4.25a.75.75 0 1 1-1.06-1.06l2.72-2.97H12a.75.75 0 0 1 0-1.5h4.44l-2.72-2.97a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
        </svg>
      </div>
    </div>
  );
}
