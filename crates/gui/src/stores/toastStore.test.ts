import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useToastStore } from "./toastStore";

describe("toastStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useToastStore.setState({ toasts: [] });
    // Use fake timers
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("has empty toasts array", () => {
      const state = useToastStore.getState();
      expect(state.toasts).toEqual([]);
    });
  });

  describe("addToast", () => {
    it("adds a toast to the array", () => {
      useToastStore.getState().addToast("Test message", "info");

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toBe("Test message");
      expect(toasts[0].type).toBe("info");
    });

    it("generates unique IDs for toasts", () => {
      useToastStore.getState().addToast("Message 1", "info");
      useToastStore.getState().addToast("Message 2", "success");

      const toasts = useToastStore.getState().toasts;
      expect(toasts[0].id).not.toBe(toasts[1].id);
    });

    it("supports different toast types", () => {
      useToastStore.getState().addToast("Info", "info");
      useToastStore.getState().addToast("Success", "success");
      useToastStore.getState().addToast("Warning", "warning");
      useToastStore.getState().addToast("Error", "error");

      const toasts = useToastStore.getState().toasts;
      expect(toasts.map((t) => t.type)).toEqual([
        "info",
        "success",
        "warning",
        "error",
      ]);
    });

    it("limits toasts to maximum of 5", () => {
      for (let i = 0; i < 7; i++) {
        useToastStore.getState().addToast(`Message ${i}`, "info");
      }

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(5);
      // Should keep the most recent 5
      expect(toasts[0].message).toBe("Message 2");
      expect(toasts[4].message).toBe("Message 6");
    });

    it("auto-removes toast after default duration", () => {
      useToastStore.getState().addToast("Temporary", "info");

      expect(useToastStore.getState().toasts).toHaveLength(1);

      // Fast-forward past default duration (4000ms)
      vi.advanceTimersByTime(4000);

      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it("uses custom duration when provided", () => {
      useToastStore.getState().addToast("Custom duration", "info", 1000);

      expect(useToastStore.getState().toasts).toHaveLength(1);

      // Not removed after 500ms
      vi.advanceTimersByTime(500);
      expect(useToastStore.getState().toasts).toHaveLength(1);

      // Removed after 1000ms
      vi.advanceTimersByTime(500);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it("does not auto-remove when duration is 0", () => {
      useToastStore.getState().addToast("Persistent", "info", 0);

      vi.advanceTimersByTime(10000);

      expect(useToastStore.getState().toasts).toHaveLength(1);
    });
  });

  describe("removeToast", () => {
    it("removes toast by ID", () => {
      useToastStore.getState().addToast("Message 1", "info");
      useToastStore.getState().addToast("Message 2", "info");

      const toasts = useToastStore.getState().toasts;
      const idToRemove = toasts[0].id;

      useToastStore.getState().removeToast(idToRemove);

      const remaining = useToastStore.getState().toasts;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].message).toBe("Message 2");
    });

    it("does nothing when ID not found", () => {
      useToastStore.getState().addToast("Message", "info");

      useToastStore.getState().removeToast("non-existent-id");

      expect(useToastStore.getState().toasts).toHaveLength(1);
    });
  });

  describe("clearToasts", () => {
    it("removes all toasts", () => {
      useToastStore.getState().addToast("Message 1", "info");
      useToastStore.getState().addToast("Message 2", "success");
      useToastStore.getState().addToast("Message 3", "error");

      useToastStore.getState().clearToasts();

      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it("works when already empty", () => {
      useToastStore.getState().clearToasts();

      expect(useToastStore.getState().toasts).toHaveLength(0);
    });
  });
});
