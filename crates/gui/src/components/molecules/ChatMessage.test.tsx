import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatMessage } from "./ChatMessage";

describe("ChatMessage", () => {
  it("renders an author label", () => {
    render(
      <ChatMessage role="assistant" author="Claude">
        Hello
      </ChatMessage>,
    );
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("supports system role", () => {
    render(<ChatMessage role="system">system note</ChatMessage>);
    expect(screen.getByText("system note")).toBeInTheDocument();
  });
});
