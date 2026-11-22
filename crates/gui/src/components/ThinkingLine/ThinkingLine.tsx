import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { useReducedMotion } from "../MachineDiagram/useReducedMotion";
import {
  getThinkingLineRenderer,
  type ThinkingLineHandle,
  type ThinkingLineMode,
} from "./renderer";
import type { ThinkingLineVariant } from "./shaders";

/**
 * Full-width shader-driven thinking line. Size it with `className`/`style`
 * (it fills its box); the shared renderer matches the canvas to the box at
 * device resolution. The canvas is decorative; `text` is kept in the DOM
 * once, screen-reader-only beside the canvas.
 *
 * Without WebGL2 (or while the GPU context is lost) the line falls back to
 * static content in the same box so the waiting state stays visible: the
 * status text, or a hairline when `fallback="hairline"` or there is no text.
 */
export function ThinkingLine({
  variant,
  mode = "thinking",
  speed = 1,
  paused = false,
  text,
  fallback = "text",
  className,
  style,
}: {
  variant: ThinkingLineVariant;
  mode?: ThinkingLineMode;
  speed?: number;
  paused?: boolean;
  /** Status phrase drawn in the line. */
  text?: string;
  /** What to show when the shader can't draw; "hairline" suits tiny boxes. */
  fallback?: "text" | "hairline";
  className?: string;
  style?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<ThinkingLineHandle | null>(null);
  const reducedMotion = useReducedMotion();
  const renderer = getThinkingLineRenderer();
  const available = useSyncExternalStore(renderer.subscribe, () =>
    renderer.isAvailable(variant)
  );
  const animate = !paused && !reducedMotion;
  const options = { variant, mode, speed, animate, text };
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = renderer.attach(canvas, optionsRef.current);
    handleRef.current = handle;

    const measure = () =>
      handle.resize(canvas.clientWidth, canvas.clientHeight);
    measure();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(canvas);
    const intersectionObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            for (const entry of entries)
              handle.setVisible(entry.isIntersecting);
          });
    intersectionObserver?.observe(canvas);

    return () => {
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      handle.dispose();
      handleRef.current = null;
    };
    // re-attach when the canvas comes back after a fallback
  }, [renderer, available]);

  useEffect(() => {
    handleRef.current?.update({ variant, mode, speed, animate, text });
  }, [variant, mode, speed, animate, text]);

  if (!available) {
    const showText = fallback === "text" && !!text;
    return (
      <span
        className={`flex min-w-0 items-center ${className ?? ""}`}
        style={{ width: "100%", ...style }}
        data-testid="thinking-line-fallback"
        data-variant={variant}
        data-mode={mode}
      >
        {showText ? (
          <span className="truncate text-sm text-[var(--color-fg-mute)]">
            {text}
          </span>
        ) : (
          <span className="h-px w-full bg-[var(--color-accent)] opacity-60" />
        )}
      </span>
    );
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        className={className}
        style={{ display: "block", width: "100%", ...style }}
        data-testid="thinking-line"
        data-variant={variant}
        data-mode={mode}
        aria-hidden="true"
      />
      {text && <span className="sr-only">{text}</span>}
    </>
  );
}
