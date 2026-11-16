import { fireEvent, screen, within } from "@testing-library/react";

/**
 * The composer collapses provider, model, effort and speed pickers into one
 * "Model settings" chip whose popover holds the selects. These helpers open
 * the popover on demand so tests can address the pickers directly.
 */

type Scope = HTMLElement | undefined;

function queries(scope: Scope) {
  return scope ? within(scope) : screen;
}

/** Open the model settings popover in scope if it is not already open. */
export function openModelSettings(scope?: HTMLElement): void {
  const q = queries(scope);
  if (q.queryByTestId("local-chat-model-settings-popover")) return;
  const trigger = q.queryByTestId("local-chat-model-settings");
  if (trigger) fireEvent.click(trigger);
}

/** Get a picker that lives in the model settings popover, opening it first. */
export function getComposerPicker(
  testId: string,
  scope?: HTMLElement
): HTMLElement {
  openModelSettings(scope);
  return queries(scope).getByTestId(testId);
}

/** Query a picker in the model settings popover, opening it first. */
export function queryComposerPicker(
  testId: string,
  scope?: HTMLElement
): HTMLElement | null {
  openModelSettings(scope);
  return queries(scope).queryByTestId(testId);
}

/** Get a picker by accessible label, opening the popover first. */
export function getComposerPickerByLabel(
  label: string | RegExp,
  scope?: HTMLElement
): HTMLElement {
  openModelSettings(scope);
  return queries(scope).getByLabelText(label);
}

/** Async variant of {@link getComposerPicker} for pickers that load late. */
export async function findComposerPicker(
  testId: string,
  scope?: HTMLElement
): Promise<HTMLElement> {
  const { waitFor } = await import("@testing-library/react");
  return waitFor(() => getComposerPicker(testId, scope));
}
