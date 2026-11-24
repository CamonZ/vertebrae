import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Dropdown } from "./Dropdown";

it.each([undefined, "Find an option"])(
  "opens and closes without scrolling an overflow-hidden ancestor (search: %s)",
  async (searchPlaceholder) => {
    const user = userEvent.setup();
    const { getByTestId } = render(
      <div data-testid="pane" style={{ overflow: "hidden" }}>
        <Dropdown
          aria-label="Model"
          options={[{ value: "first", label: "First" }]}
          value="first"
          onChange={() => {}}
          searchPlaceholder={searchPlaceholder}
        />
      </div>
    );
    const pane = getByTestId("pane");
    const trigger = screen.getByRole("button", { name: "Model" });
    trigger.focus();
    const nativeFocus = HTMLElement.prototype.focus;
    // jsdom focuses elements but does not simulate the accompanying scroll.
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(
      function (this: HTMLElement, options) {
        if (pane.contains(this) && !options?.preventScroll) pane.scrollTop = 100;
        nativeFocus.call(this, options);
      }
    );

    try {
      await user.keyboard("{ArrowDown}");
      const menuFocus = screen.getByRole(searchPlaceholder ? "combobox" : "listbox");
      expect(menuFocus).toHaveFocus();
      expect(pane.scrollTop).toBe(0);

      await user.keyboard("{Escape}");
      expect(trigger).toHaveFocus();
      expect(pane.scrollTop).toBe(0);
    } finally {
      focus.mockRestore();
    }
  }
);

it.each([
  // 74px below the trigger: the 72px menu fits only without its 4px gap.
  { below: 74, up: true },
  { below: 80, up: false },
])("flips up when the menu and its gap do not fit below (below: $below)", async ({ below, up }) => {
  const user = userEvent.setup();
  const triggerTop = window.innerHeight - below - 26;
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top }) as DOMRect;
  const bounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("dd")) return rect(triggerTop, 26);
      if (this.classList.contains("dd-menu")) return rect(triggerTop + 26 + 4, 72);
      return rect(0, 0);
    });
  const height = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("dd-menu") ? 72 : 0;
    });
  // jsdom reports the document's ancestors as clipping with no height.
  const clientHeight = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockImplementation(() => window.innerHeight);

  try {
    render(
      <Dropdown
        aria-label="Speed"
        options={[
          { value: "standard", label: "Standard" },
          { value: "fast", label: "Fast" },
        ]}
        value="standard"
        onChange={() => {}}
      />
    );
    await user.click(screen.getByRole("button", { name: "Speed" }));
    expect(screen.getByRole("listbox").closest(".dd-menu")?.hasAttribute("data-up")).toBe(up);
  } finally {
    bounds.mockRestore();
    height.mockRestore();
    clientHeight.mockRestore();
  }
});
