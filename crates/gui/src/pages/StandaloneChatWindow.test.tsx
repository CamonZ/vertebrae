import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { StandaloneChatWindow } from "./StandaloneChatWindow";
import { useChatStore } from "../stores/chatStore";
import { stashChatSession } from "../utils/chatStash";

// Stub WindowLayout so we don't pull in GlobalListeners + ToastContainer.
vi.mock("../components/WindowLayout", () => ({
  WindowLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="window-layout">{children}</div>
  ),
}));

// Stub ChatWindow so the test stays focused on the page's seeding logic
// and doesn't pull in useLocalChat's backend bindings.
vi.mock("../components/ChatWindow/ChatWindow", () => ({
  ChatWindow: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="chat-window">{sessionId}</div>
  ),
}));

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/chat" element={<StandaloneChatWindow />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("StandaloneChatWindow", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      panelOpen: false,
    });
    localStorage.clear();
  });

  it("seeds the chat store from the localStorage stash before first paint", () => {
    stashChatSession({
      id: "s-99",
      label: "Stashed",
      messages: [],
      status: "open",
      harness: "claude",
      backendSessionId: "claude-99",
      providerResumeId: "conv-99",
      isDetached: true,
    });

    renderAt("/chat?sessionId=s-99");

    expect(screen.getByTestId("chat-window").textContent).toBe("s-99");
    const seeded = useChatStore.getState().sessions["s-99"];
    expect(seeded).toBeDefined();
    expect(seeded.backendSessionId).toBe("claude-99");
    expect(seeded.providerResumeId).toBe("conv-99");
    expect(useChatStore.getState().activeSessionId).toBe("s-99");
    // Stash entry was consumed so a future window doesn't re-seed stale data
    expect(localStorage.getItem("chat-stash:s-99")).toBeNull();
  });

  it("renders an error message when sessionId query param is missing", () => {
    renderAt("/chat");
    expect(screen.queryByTestId("chat-window")).not.toBeInTheDocument();
    expect(
      screen.getByText("Missing sessionId query parameter")
    ).toBeInTheDocument();
  });

  it("still renders ChatWindow when no stash exists (relying on broadcast events to populate)", () => {
    renderAt("/chat?sessionId=s-only-route");
    expect(screen.getByTestId("chat-window").textContent).toBe("s-only-route");
  });

});
