import { describe, expect, it } from "vitest";
import {
  getNotificationPanelPlacement,
  SIDE_PANEL_MAXIMIZED_LEFT_INSET_PX,
  type RegisteredPanelLayout,
} from "./panelLayoutStore";

function panel(
  renderedWidth: number,
  rightOffset = 0,
  overrides: Partial<RegisteredPanelLayout> = {}
): RegisteredPanelLayout {
  return {
    isPresent: true,
    renderedWidth,
    rightOffset,
    ...overrides,
  };
}

describe("getNotificationPanelPlacement", () => {
  it("uses the base right inset when no side panels are open", () => {
    expect(getNotificationPanelPlacement({}, 1200, 486)).toEqual({
      mode: "right",
      rightOffset: 0,
    });
  });

  it("places notifications left of the leftmost registered panel", () => {
    const placement = getNotificationPanelPlacement(
      {
        chat: panel(384),
        "task-detail": panel(420, 396),
        "artifact-inspector": panel(486, 828),
      },
      2200,
      486
    );

    expect(placement).toEqual({
      mode: "left-of-leftmost",
      rightOffset: 1326,
      leftmostPanelId: "artifact-inspector",
    });
  });

  it("overlays the leftmost panel when there is no room for another panel", () => {
    const placement = getNotificationPanelPlacement(
      {
        chat: panel(384),
        "task-detail": panel(420, 396),
        "artifact-inspector": panel(486, 828),
      },
      1400,
      486
    );

    expect(placement).toEqual({
      mode: "overlay",
      rightOffset: 828,
      leftmostPanelId: "artifact-inspector",
    });
  });

  it("overlays the left side of maximized chat", () => {
    expect(
      getNotificationPanelPlacement(
        {
          chat: panel(1128, 0, {
            isMaximized: true,
            leftOffset: SIDE_PANEL_MAXIMIZED_LEFT_INSET_PX,
          }),
          "task-detail": panel(420, 0),
        },
        1200,
        486
      )
    ).toEqual({
      mode: "maximized-chat",
      leftOffset: SIDE_PANEL_MAXIMIZED_LEFT_INSET_PX,
      leftmostPanelId: "chat",
    });
  });
});
