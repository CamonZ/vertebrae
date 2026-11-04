import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { clampSidebar, sidebarBounds } from "./useSidebarResize";

test("generated widths and drag deltas stay bounded; temporary shrink and collapse preserve the preferred width", () =>
  hegel.test((tc) => {
    const container = tc.draw(gs.integers({ minValue: 0, maxValue: 3000 }));
    const width = tc.draw(gs.integers({ minValue: -1000, maxValue: 4000 }));
    const delta = tc.draw(gs.integers({ minValue: -3000, maxValue: 3000 }));
    const preferred = clampSidebar(width + delta, container);
    const { min, max } = sidebarBounds(container);

    expect(preferred).toBeGreaterThanOrEqual(min);
    expect(preferred).toBeLessThanOrEqual(max);
    expect(clampSidebar(preferred, container)).toBe(preferred);

    const shrunk = clampSidebar(preferred, Math.min(container, 320));
    expect(shrunk).toBeLessThanOrEqual(preferred);
    // Neither a collapsed view nor a smaller viewport writes to the preference.
    expect(clampSidebar(preferred, container)).toBe(preferred);
  }));
