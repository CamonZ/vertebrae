import { fireEvent, screen, within } from "@testing-library/react";

/**
 * Pane headers keep a few inline controls and move the rest into a `⋯`
 * overflow menu. These helpers activate a pane control by accessible name,
 * preferring the inline button and falling back to the overflow menu, so
 * tests stay agnostic about where a control currently lives.
 */

const MENU_TRIGGER = "More pane actions";

type Scope = HTMLElement | undefined;

function queries(scope: Scope) {
  return scope ? within(scope) : screen;
}

function inlineButton(name: string, scope: Scope): HTMLElement | null {
  return queries(scope).queryAllByRole("button", { name })[0] ?? null;
}

function menuTrigger(scope: Scope): HTMLElement {
  const trigger = queries(scope).queryAllByRole("button", {
    name: MENU_TRIGGER,
  })[0];
  if (!trigger) throw new Error(`No "${MENU_TRIGGER}" trigger in scope`);
  return trigger;
}

/** Synchronously click a pane control (inline or via the overflow menu). */
export function firePaneControl(name: string, scope?: HTMLElement): void {
  const inline = inlineButton(name, scope);
  if (inline) {
    fireEvent.click(inline);
    return;
  }
  fireEvent.click(menuTrigger(scope));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

interface ClickUser {
  click: (element: Element) => Promise<void>;
}

/** user-event variant of {@link firePaneControl}. */
export async function clickPaneControl(
  user: ClickUser,
  name: string,
  scope?: HTMLElement
): Promise<void> {
  const inline = inlineButton(name, scope);
  if (inline) {
    await user.click(inline);
    return;
  }
  await user.click(menuTrigger(scope));
  await user.click(screen.getByRole("menuitem", { name }));
}

/**
 * Return a pane control element (inline button or menu item, opening the
 * menu if needed) for assertions such as `toBeDisabled()`.
 */
export function getPaneControl(name: string, scope?: HTMLElement): HTMLElement {
  const inline = inlineButton(name, scope);
  if (inline) return inline;
  const open = screen.queryByRole("menuitem", { name });
  if (open) return open;
  fireEvent.click(menuTrigger(scope));
  return screen.getByRole("menuitem", { name });
}

/** Whether a pane control is reachable at all (inline or in the menu). */
export function hasPaneControl(name: string, scope?: HTMLElement): boolean {
  if (inlineButton(name, scope)) return true;
  const trigger = queries(scope).queryAllByRole("button", {
    name: MENU_TRIGGER,
  })[0];
  if (!trigger) return false;
  fireEvent.click(trigger);
  const found = screen.queryByRole("menuitem", { name }) !== null;
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  return found;
}

