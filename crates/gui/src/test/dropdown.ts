import { fireEvent, screen, within } from "@testing-library/react";

/**
 * Pick a value in a `Dropdown` (the app's custom listbox picker): open it
 * from its trigger and click the option whose value matches.
 */
export function chooseDropdownValue(trigger: HTMLElement, value: string): void {
  fireEvent.click(trigger);
  const listbox = screen.getByRole("listbox");
  const option = within(listbox)
    .getAllByRole("option")
    .find((candidate) => candidate.getAttribute("data-value") === value);
  if (!option) throw new Error(`No dropdown option with value "${value}"`);
  fireEvent.click(option);
}

/** Option values of a Dropdown, read from its open listbox (opens it if needed). */
export function dropdownOptionValues(trigger: HTMLElement): string[] {
  return readOptions(trigger).map((entry) => entry.value);
}

/** [label, value] pairs of a Dropdown's options. */
export function dropdownOptions(
  trigger: HTMLElement
): { label: string; value: string; disabled: boolean }[] {
  return readOptions(trigger);
}

/** One option of a Dropdown by visible label (null when absent). */
export function getDropdownOption(
  trigger: HTMLElement,
  label: string
): { label: string; value: string; disabled: boolean } | null {
  return readOptions(trigger).find((option) => option.label === label) ?? null;
}

function readOptions(
  trigger: HTMLElement
): { label: string; value: string; disabled: boolean }[] {
  if ((trigger as HTMLButtonElement).disabled) {
    throw new Error("Cannot read the options of a disabled Dropdown");
  }
  const wasOpen = trigger.getAttribute("aria-expanded") === "true";
  if (!wasOpen) fireEvent.click(trigger);
  const listbox = screen.getByRole("listbox");
  const entries = within(listbox)
    .queryAllByRole("option")
    .map((option) => ({
      label: option.textContent ?? "",
      value: option.getAttribute("data-value") ?? "",
      disabled: option.getAttribute("aria-disabled") === "true",
    }));
  if (!wasOpen) fireEvent.click(trigger);
  return entries;
}
