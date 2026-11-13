import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NO_FACTORY_SCOPE } from "../../utils/workflowFactory";
import { FactoryIndex } from "./FactoryIndex";
import {
  factoryLinkCounts,
  NO_FACTORY_KEY,
  separateRects,
  type FactoryOverviewGroup,
} from "./factoryOverviewModel";

function group(
  name: string,
  overrides: Partial<FactoryOverviewGroup> = {}
): FactoryOverviewGroup {
  return {
    name,
    scope: name,
    workflowIds: [],
    workflowCount: 1,
    workItemCount: 0,
    activeCount: 0,
    ...overrides,
  };
}

const GROUPS = [
  group("Alpha", { workflowCount: 3, workItemCount: 12, activeCount: 2 }),
  group(
    "A factory with a very long name that should wrap onto a second line and then clamp"
  ),
  group("No Factory", { scope: NO_FACTORY_SCOPE }),
];

function renderIndex(props: Partial<Parameters<typeof FactoryIndex>[0]> = {}) {
  const onHover = vi.fn();
  const onSelect = vi.fn();
  render(
    <FactoryIndex
      groups={GROUPS}
      totalCount={GROUPS.length}
      query=""
      hotKey={null}
      recentKey={null}
      linkCounts={new Map([["Alpha", 2]])}
      onHover={onHover}
      onSelect={onSelect}
      {...props}
    />
  );
  return { onHover, onSelect };
}

describe("FactoryIndex", () => {
  it("lists every factory with its size, links and activity", () => {
    renderIndex();
    expect(
      screen.getByRole("navigation", { name: "Factories" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    const alpha = screen.getByTestId("factory-index-row-Alpha");
    expect(alpha).toHaveTextContent("3 workflows");
    expect(alpha).toHaveTextContent("12 items");
    expect(alpha).toHaveTextContent("2 links");
    expect(alpha).toHaveTextContent("2 active");
    const single = screen.getByTestId("factory-index-row-No Factory");
    expect(single).toHaveTextContent("1 workflow");
    expect(single).not.toHaveTextContent("items");
    expect(single).not.toHaveTextContent("active");
  });

  it("keeps the full name of long factories in a tooltip", () => {
    renderIndex();
    const long = GROUPS[1].name;
    expect(screen.getByTestId(`factory-index-row-${long}`)).toHaveAttribute(
      "title",
      long
    );
  });

  it("opens a factory with its exact scope", () => {
    const { onSelect } = renderIndex();
    fireEvent.click(screen.getByTestId("factory-index-row-No Factory"));
    expect(onSelect).toHaveBeenCalledWith(NO_FACTORY_SCOPE);
  });

  it("reports hover and focus so the map can highlight the factory", () => {
    const { onHover } = renderIndex();
    const alpha = screen.getByTestId("factory-index-row-Alpha");
    fireEvent.mouseEnter(alpha);
    expect(onHover).toHaveBeenLastCalledWith("Alpha");
    fireEvent.mouseLeave(alpha);
    expect(onHover).toHaveBeenLastCalledWith(null);
    fireEvent.focus(screen.getByTestId("factory-index-row-No Factory"));
    expect(onHover).toHaveBeenLastCalledWith(NO_FACTORY_KEY);
  });

  it("marks the highlighted factory", () => {
    renderIndex({ hotKey: "Alpha" });
    expect(screen.getByTestId("factory-index-row-Alpha")).toHaveClass("is-hot");
  });

  it("moves focus with the arrow, Home and End keys using one tab stop", () => {
    renderIndex();
    const rows = screen.getAllByRole("button");
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1], { key: "End" });
    expect(rows[2]).toHaveFocus();
    fireEvent.keyDown(rows[2], { key: "ArrowDown" });
    expect(rows[2]).toHaveFocus();
    fireEvent.keyDown(rows[2], { key: "Home" });
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(rows[0], { key: "ArrowUp" });
    expect(rows[0]).toHaveFocus();
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);
  });

  it("marks and starts focus at the factory the user last opened", () => {
    renderIndex({ recentKey: NO_FACTORY_KEY });
    const recent = screen.getByTestId("factory-index-row-No Factory");
    expect(recent).toHaveAttribute("aria-current", "location");
    expect(recent).toHaveTextContent("last opened");
    expect(recent.tabIndex).toBe(0);
    expect(screen.getByTestId("factory-index-row-Alpha").tabIndex).toBe(-1);
  });

  it("shows how many factories match a search", () => {
    renderIndex({ groups: GROUPS.slice(0, 1), query: "alp" });
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });

  it("explains an empty search", () => {
    renderIndex({ groups: [], query: "zzz" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "No factories matchzzz"
    );
  });

  it("explains a project without factories", () => {
    renderIndex({ groups: [], totalCount: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("No factories yet");
  });
});

describe("factoryLinkCounts", () => {
  it("counts distinct neighbours in either direction", () => {
    const counts = factoryLinkCounts([
      { from: "A", to: "B" },
      { from: "B", to: "A" },
      { from: "B", to: "C" },
    ]);
    expect(counts.get("A")).toBe(1);
    expect(counts.get("B")).toBe(2);
    expect(counts.get("C")).toBe(1);
  });
});

describe("separateRects", () => {
  const rect = (x: number, y: number) => ({ x, y, w: 100, h: 30 });

  it("leaves rects that do not overlap where they are", () => {
    const rects = [rect(0, 0), rect(200, 0), rect(0, 100)];
    expect(separateRects(rects, 6)).toEqual(rects);
  });

  it("pushes overlapping rects below each other, keeping input order", () => {
    const result = separateRects([rect(10, 4), rect(0, 0), rect(5, 2)], 6);
    expect(result[1]).toEqual(rect(0, 0));
    expect(result[2]).toEqual(rect(5, 36));
    expect(result[0]).toEqual(rect(10, 72));
  });
});
