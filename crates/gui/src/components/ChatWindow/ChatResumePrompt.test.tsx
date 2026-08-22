import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatResumePrompt } from "./ChatResumePrompt";

describe("ChatResumePrompt", () => {
  it("renders the persisted title and exposes separate continue/new actions", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    const onNewChat = vi.fn();

    render(
      <ChatResumePrompt
        session={{ id: "session-1", label: "Fallback", title: "Review API" }}
        onContinue={onContinue}
        onNewChat={onNewChat}
      />
    );

    expect(
      screen.getByRole("link", {
        name: "continue with the last session Review API",
      })
    ).toBeInTheDocument();
    expect(screen.getByText("or").parentElement).toHaveClass("font-normal");

    await user.click(screen.getByRole("link"));
    await user.click(screen.getByRole("button", { name: "new chat" }));

    expect(onContinue).toHaveBeenCalledOnce();
    expect(onNewChat).toHaveBeenCalledOnce();
  });
});
