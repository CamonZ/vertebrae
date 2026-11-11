import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MachinePartsGalleryPage } from "./MachinePartsGalleryPage";
import { MACHINE_PARTS } from "../components/MachineDiagram/parts";
import { UNIVERSAL_STATES } from "../components/MachineDiagram";
import { useUIStore } from "../stores/uiStore";
import { appRoutes } from "../router";
import { DEV_MACHINE_PARTS_PATH } from "../devRoutes";

// Part rendering is covered individually in parts/parts.test.tsx. Keep page
// interaction tests independent of the size of the production catalogue.
vi.mock("../components/MachineDiagram/parts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/MachineDiagram/parts")>();
  return {
    ...actual,
    MACHINE_PARTS: {
      source: actual.MACHINE_PARTS.source,
      pool: actual.MACHINE_PARTS.pool,
    },
  };
});

/** Queued animation frames; tests run them explicitly. */
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.spyOn(performance, "now").mockReturnValue(0);
});

afterEach(() => {
  useUIStore.getState().setTheme("system");
  vi.restoreAllMocks();
});

const cells = (name: string) => screen.queryAllByTestId(`gallery-cell-${name}`);

describe("MachinePartsGalleryPage", () => {
  it("switches the app theme between light and dark", () => {
    render(<MachinePartsGalleryPage />);
    const toolbar = screen.getByRole("toolbar", { name: "Gallery controls" });
    fireEvent.click(within(toolbar).getByText("light"));
    expect(useUIStore.getState().theme).toBe("light");
    fireEvent.click(within(toolbar).getByText("dark"));
    expect(useUIStore.getState().theme).toBe("dark");
  });

  it("hides every part label with the labels toggle", () => {
    const { container } = render(<MachinePartsGalleryPage />);
    const partText = () => container.querySelectorAll(".md-part text").length;
    expect(partText()).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Labels off" }));
    // Only single-character mechanism glyphs (the source caret) survive.
    const left = [...container.querySelectorAll(".md-part text")].map(
      (t) => t.textContent ?? ""
    );
    expect(left.every((s) => s.length <= 1)).toBe(true);
  });

  it("filters by part and by change mark", () => {
    render(<MachinePartsGalleryPage />);
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Parts" })).getByText("pool")
    );
    expect(cells("source")).toHaveLength(0);
    fireEvent.click(
      screen.getByText("~ changed", { selector: "button *, button" })
    );
    const pool = MACHINE_PARTS.pool;
    expect(cells("pool")).toHaveLength(
      pool.scenarios.length + UNIVERSAL_STATES.length
    );
  });

  it("plays scenario timelines by default and can show stills", () => {
    render(<MachinePartsGalleryPage />);
    const firstSource = () => cells("source")[0].innerHTML;
    expect(screen.getByRole("button", { name: "Show stills" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    const before = firstSource();
    act(() => frames.at(-1)?.(1500));
    expect(firstSource()).not.toBe(before);
    expect(frames.length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "Show stills" }));
    expect(
      screen.getByRole("button", { name: "Play scenarios" })
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("starts on still frames when the user prefers reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("reduce"),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList
    );
    render(<MachinePartsGalleryPage />);
    expect(
      screen.getByRole("button", { name: "Play scenarios" })
    ).toHaveAttribute("aria-pressed", "false");
    expect(frames).toHaveLength(0);
  });

  it("is routed in dev builds", () => {
    const root = appRoutes.find((r) => r.path === "/");
    expect(
      root?.children?.some((r) => r.path === DEV_MACHINE_PARTS_PATH.slice(1))
    ).toBe(import.meta.env.DEV);
  });
});
