import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VtbEntityCopyProvider, VtbEntityLink } from "./VtbEntityLink";
import { parseVtbEntityHref } from "./vtbEntityLinkTarget";

const ID = "860cde1b-9093-42ff-a19d-7453f3b7891b";
const types = ["ticket", "workflow", "step", "artifact"] as const;

describe("chat entity references", () => {
  it.each(types)(
    "copies full %s IDs by mouse, Enter, and Space without opening or bubbling",
    async (type) => {
      const user = userEvent.setup();
      const writeText = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockResolvedValue();
      const onOpen = vi.fn();
      const surroundingClick = vi.fn();
      const surroundingKey = vi.fn();
      const target = parseVtbEntityHref(`vtb://${type}/${ID}`)!;
      render(
        <div onClick={surroundingClick} onKeyDown={surroundingKey}>
          <VtbEntityCopyProvider>
            <VtbEntityLink target={target} onOpen={onOpen}>
              A title
            </VtbEntityLink>
          </VtbEntityCopyProvider>
        </div>
      );
      const link = screen.getByRole("link");
      const copy = screen.getByRole("button", { name: `Copy full ${type} ID` });
      expect(copy.closest("a")).toBeNull();
      expect(copy).toHaveClass("focus-visible:ring-2");
      await user.tab();
      expect(link).toHaveFocus();
      await user.tab();
      expect(copy).toHaveFocus();
      surroundingKey.mockClear();
      await user.click(copy);
      await user.keyboard("{Enter}");
      await user.keyboard(" ");
      expect(writeText.mock.calls).toEqual([[ID], [ID], [ID]]);
      expect(copy).toHaveAccessibleName(`Copied ${type} ID`);
      expect(copy).toHaveAttribute("title", "Copied");
      expect(onOpen).not.toHaveBeenCalled();
      expect(surroundingClick).not.toHaveBeenCalled();
      expect(surroundingKey).not.toHaveBeenCalled();
      await user.click(link);
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(target);
      expect(surroundingClick).not.toHaveBeenCalled();
    }
  );

  it.each(["metaKey", "ctrlKey", "shiftKey", "altKey"])(
    "preserves %s link navigation",
    (modifier) => {
      const onOpen = vi.fn();
      const target = parseVtbEntityHref(`vtb://ticket/${ID}`)!;
      render(
        <VtbEntityCopyProvider>
          <VtbEntityLink target={target} onOpen={onOpen}>
            Ticket
          </VtbEntityLink>
        </VtbEntityCopyProvider>
      );
      const link = screen.getByRole("link");
      const browserNavigation = vi.fn((event: MouseEvent) => {
        expect(event.defaultPrevented).toBe(false);
        event.preventDefault(); // Avoid jsdom attempting browser navigation.
      });
      document.addEventListener("click", browserNavigation, { once: true });
      fireEvent.click(link, { [modifier]: true });
      expect(browserNavigation).toHaveBeenCalledOnce();
      expect(onOpen).not.toHaveBeenCalled();
      expect(link).toHaveAttribute("href", target.route);
    }
  );

  it("does not report success when clipboard writing fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new Error("denied")
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <VtbEntityCopyProvider>
        <VtbEntityLink
          target={parseVtbEntityHref(`vtb://artifact/${ID}`)!}
          onOpen={vi.fn()}
        >
          Report
        </VtbEntityLink>
      </VtbEntityCopyProvider>
    );
    const copy = screen.getByRole("button");
    await user.click(copy);
    expect(copy).toHaveAccessibleName("Copy full artifact ID");
    expect(copy).not.toHaveAttribute("title", "Copied");
    expect(error).toHaveBeenCalledWith(
      "Failed to copy entity ID",
      expect.any(Error)
    );
    error.mockRestore();
  });

  it("resets established copied feedback after 1200ms", async () => {
    userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    vi.useFakeTimers();
    try {
      render(
        <VtbEntityCopyProvider>
          <VtbEntityLink
            target={parseVtbEntityHref(`vtb://step/${ID}`)!}
            onOpen={vi.fn()}
          >
            Step
          </VtbEntityLink>
        </VtbEntityCopyProvider>
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button"));
      });
      expect(screen.getByRole("button")).toHaveAccessibleName("Copied step ID");
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(screen.getByRole("button")).toHaveAccessibleName(
        "Copy full step ID"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves non-chat references without copy controls", () => {
    render(
      <VtbEntityLink
        target={parseVtbEntityHref(`vtb://ticket/${ID}`)!}
        onOpen={vi.fn()}
      >
        Ticket
      </VtbEntityLink>
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
