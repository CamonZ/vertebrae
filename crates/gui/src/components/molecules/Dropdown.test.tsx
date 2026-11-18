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
