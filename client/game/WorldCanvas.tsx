import { useLayoutEffect, useRef } from "react";
import { WorldRenderer, type WorldCanvasProps } from "./renderer";

export type { WorldCanvasProps } from "./renderer";

export function WorldCanvas(props: WorldCanvasProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const current = useRef(props);

  useLayoutEffect(() => {
    current.current = props;
    renderer.current?.update(props);
  }, [props]);

  // A single renderer owns RAF, caches, input listeners, and audio for this mount.
  // Snapshot/callback changes update the instance above, never restart its loop.
  useLayoutEffect(() => {
    if (!canvas.current || !host.current) return;
    const instance = new WorldRenderer(canvas.current, host.current, current.current);
    renderer.current = instance;
    return () => {
      instance.destroy();
      if (renderer.current === instance) renderer.current = null;
    };
  }, []);

  return (
    <div
      ref={host}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 320,
        minWidth: 0,
        flex: "1 1 auto",
        overflow: "hidden",
        background: "#439b30",
      }}
    >
      <canvas
        ref={canvas}
        data-testid="world-canvas"
        role="application"
        tabIndex={0}
        aria-label={`${props.world.name}: interactive pixel meadow`}
        aria-description={`Arrow keys move the target; hold Shift for larger steps. Enter or Space ${props.world.hatched ? `uses ${props.tool}` : "hatches the egg"}. Escape clears selection. Select a creature to read its thoughts in the mind panel.`}
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
          minHeight: 320,
          touchAction: "manipulation",
          cursor: props.tool === "inspect" ? "pointer" : "crosshair",
          imageRendering: "pixelated",
        }}
      >
        An interactive rectangular pixel meadow. Use arrow keys to move the target and Enter to
        interact. Creature status and thoughts are available in the surrounding interface.
      </canvas>
    </div>
  );
}
