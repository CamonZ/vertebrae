import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Bar, Burst, Lamp, PartBox, Ring, Spinner, Terminal } from "./fixtures";
import { arcPath, lampAt, litAt, ringGeometry } from "./geometry";
import { PartContext } from "./partContext";
import { Press } from "./Press";
import { Card } from "./Card";
import type { CardFrame } from "./timeline";

function draw(node: ReactNode, fade = 1, removed = false) {
  return render(
    <svg>
      <PartContext.Provider
        value={{ fade, removed, labels: true, hatchId: "h" }}
      >
        {node}
      </PartContext.Provider>
    </svg>
  ).container;
}

describe("arcPath", () => {
  it("draws partial arcs with the right large-arc flag", () => {
    expect(arcPath(0, 0, 10, 0, Math.PI / 2)).toBe("M10 0 A10 10 0 0 1 0 10");
    expect(arcPath(0, 0, 10, 0, 1.5 * Math.PI)).toContain(" 0 1 1 ");
    expect(arcPath(0, 0, 10, 1, 1)).toBe("");
  });

  it("draws a full circle as two arcs", () => {
    expect(arcPath(0, 0, 10, 0, 2 * Math.PI).match(/A/g)).toHaveLength(2);
  });
});

describe("Ring", () => {
  it("fills amber from the top, then pops in the result colour and unwinds", () => {
    expect(ringGeometry(0.9, 1, 2, "green")).toBeNull();
    const filling = ringGeometry(1.5, 1, 2, "green")!;
    expect(filling.role).toBe("amber");
    expect(filling.a1 - filling.a0).toBeCloseTo(Math.PI, 9);
    const popped = ringGeometry(2.05, 1, 2, "green")!;
    expect(popped.role).toBe("green");
    expect(popped.radius).toBeGreaterThan(24);
    expect(ringGeometry(2.5, 1, 2, "green")).toBeNull();
    expect(ringGeometry(2.05, 1, 2, null)).toBeNull();
  });

  it("renders the arc only while it is visible", () => {
    expect(
      draw(
        <Ring x={0} y={0} t={1.5} from={1} to={2} result="red" />
      ).querySelector("path.md-ring")
    ).not.toBeNull();
    expect(
      draw(
        <Ring x={0} y={0} t={3} from={1} to={2} result="red" />
      ).querySelector("path")
    ).toBeNull();
  });
});

describe("Spinner, Burst, Terminal", () => {
  it("spins amber only inside its window, fading at the ends", () => {
    expect(
      draw(<Spinner x={0} y={0} t={0.5} from={1} to={3} />).querySelector(
        "path"
      )
    ).toBeNull();
    const mid = draw(
      <Spinner x={0} y={0} t={2} from={1} to={3} />
    ).querySelector("path")!;
    expect(mid.getAttribute("stroke")).toBe("var(--md-amber)");
    expect(mid.getAttribute("opacity")).toBe("1");
    const edge = draw(
      <Spinner x={0} y={0} t={1.1} from={1} to={3} />
    ).querySelector("path")!;
    expect(Number(edge.getAttribute("opacity"))).toBeLessThan(1);
  });

  it("bursts outward for 0.8 s", () => {
    expect(
      draw(<Burst x={0} y={0} t={1} at={1} role="red" />).querySelector(
        "circle"
      )
    ).toBeNull();
    const c = draw(
      <Burst x={0} y={0} t={1.4} at={1} role="red" />
    ).querySelector("circle")!;
    expect(Number(c.getAttribute("r"))).toBeCloseTo(35, 9);
    expect(Number(c.getAttribute("opacity"))).toBeCloseTo(0.5, 9);
    expect(
      draw(<Burst x={0} y={0} t={1.9} at={1} role="red" />).querySelector(
        "circle"
      )
    ).toBeNull();
  });

  it("fills a terminal with the outcome after it lands", () => {
    expect(
      draw(
        <Terminal x={0} y={0} t={1} at={null} role="green" />
      ).querySelectorAll("circle")
    ).toHaveLength(1);
    const landed = draw(
      <Terminal x={0} y={0} t={1.5} at={1} role="green" />
    ).querySelectorAll("circle");
    expect(landed[1].getAttribute("fill")).toBe("var(--md-green)");
  });
});

describe("Lamp and Bar", () => {
  it("lampAt follows the lamp timeline with a pop, capped at 1.1", () => {
    const steps = [
      [0, "off"],
      [1, "amber"],
      [2, "off"],
    ] as const;
    expect(lampAt(steps, 0.5)).toEqual([null, 0]);
    const [role, k] = lampAt(steps, 1.5);
    expect(role).toBe("amber");
    expect(k).toBeLessThanOrEqual(1.1);
    expect(lampAt(steps, 2.5)).toEqual([null, 0]);
  });

  it("lights a lamp in its role with the loop fade", () => {
    const c = draw(
      <Lamp x={0} y={0} r={9} role="green" k={1} />,
      0.5
    ).querySelectorAll("circle");
    expect(c[1].getAttribute("fill")).toBe("var(--md-green)");
    expect(c[1].getAttribute("opacity")).toBe("0.5");
    expect(
      draw(<Lamp x={0} y={0} r={9} role={null} k={1} />).querySelectorAll(
        "circle"
      )
    ).toHaveLength(1);
  });

  it("grows bars from the left and skips empty ones", () => {
    const r = draw(
      <Bar x={10} y={0} w={100} role="ink" k={0.5} />
    ).querySelector("rect")!;
    expect(r.getAttribute("width")).toBe("50");
    expect(
      draw(<Bar x={10} y={0} w={100} role="ink" k={0} />).querySelector("rect")
    ).toBeNull();
  });
});

describe("PartBox", () => {
  it("dashes the frame for regions and removed parts", () => {
    const edge = (c: HTMLElement) =>
      c.querySelectorAll("rect")[1].getAttribute("stroke-dasharray");
    expect(edge(draw(<PartBox x={0} y={0} w={10} h={10} />))).toBeNull();
    expect(edge(draw(<PartBox x={0} y={0} w={10} h={10} dashed />))).toBe(
      "6 6"
    );
    expect(edge(draw(<PartBox x={0} y={0} w={10} h={10} />, 1, true))).toBe(
      "6 6"
    );
  });
});

describe("Press", () => {
  it("counts lit lights until the release", () => {
    expect(litAt([1, 2, 3], 2.5, 4)).toBe(2);
    expect(litAt([1, 2, 3], 4, 4)).toBe(0);
  });

  it("closes the plates, glows amber and throws sparks on impact", () => {
    const open = draw(
      <Press cx={320} cy={200} half={80} closed={0} lit={0} t={0} />
    );
    expect(open.querySelectorAll("line")).toHaveLength(0);
    const plates = (c: HTMLElement) =>
      [...c.querySelectorAll("rect[width='72']")].map((r) =>
        Number(r.getAttribute("y"))
      );
    const [top0, bottom0] = plates(open);
    const shut = draw(
      <Press
        cx={320}
        cy={200}
        half={80}
        closed={1}
        lit={6}
        clampAt={1}
        t={1.2}
      />
    );
    const [top1, bottom1] = plates(shut);
    expect(bottom1 - top1).toBeLessThan(bottom0 - top0);
    expect(shut.querySelectorAll("rect[fill='var(--md-amber)']").length).toBe(
      13
    );
    expect(shut.querySelectorAll("line")).toHaveLength(6);
  });

  it("rotates for horizontal plates", () => {
    const c = draw(
      <Press
        cx={10}
        cy={20}
        half={40}
        closed={0}
        lit={0}
        t={0}
        vertical={false}
      />
    );
    expect(c.querySelector(".md-press")?.getAttribute("transform")).toBe(
      "rotate(90 10 20)"
    );
  });
});

describe("Card", () => {
  const base: CardFrame = {
    index: 0,
    x: 100,
    y: 50,
    w: 28,
    h: 18,
    dot: false,
    hollow: false,
    badge: false,
    role: "amber",
    alpha: 1,
    angle: 38,
    ghosts: [],
    tags: [{ text: "request", x: 100, y: 28, alpha: 1, role: "amber" }],
  };

  it("leans, tags and badges a card", () => {
    const c = draw(<Card frame={{ ...base, badge: true }} />);
    expect(c.querySelector("g[transform]")?.getAttribute("transform")).toBe(
      "translate(100 50) rotate(38)"
    );
    expect(c.textContent).toBe("request");
    expect(c.querySelector("circle")?.getAttribute("fill")).toBe(
      "var(--md-green)"
    );
  });

  it("draws hollow control cards as an outline over the background", () => {
    const r = draw(<Card frame={{ ...base, hollow: true }} />).querySelector(
      "rect"
    )!;
    expect(r.getAttribute("fill")).toBe("var(--md-bg)");
    expect(r.getAttribute("stroke")).toBe("var(--md-amber)");
  });

  it("draws dots as circles", () => {
    expect(
      draw(<Card frame={{ ...base, dot: true, w: 14, tags: [] }} />)
        .querySelector("circle")
        ?.getAttribute("r")
    ).toBe("7");
  });
});
