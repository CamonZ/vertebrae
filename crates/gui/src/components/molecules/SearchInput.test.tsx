import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchInput } from "./SearchInput";

describe("SearchInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces onSearch calls", () => {
    const onSearch = vi.fn();
    render(<SearchInput aria-label="q" onSearch={onSearch} debounceMs={150} />);
    const input = screen.getByLabelText("q");
    fireEvent.change(input, { target: { value: "ab" } });
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onSearch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(150));
    expect(onSearch).toHaveBeenCalledExactlyOnceWith("abc");
  });

  it("clears on Escape", () => {
    const onSearch = vi.fn();
    render(
      <SearchInput aria-label="q" defaultValue="abc" onSearch={onSearch} />,
    );
    const input = screen.getByLabelText("q") as HTMLInputElement;
    expect(input.value).toBe("abc");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });
});
