import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { AcceptanceCriteria } from "./AcceptanceCriteria";
import type { Section } from "../../bindings";

vi.mock("../../bindings", () => ({
  commands: {
    toggleChecklistItemDone: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: null }),
  },
}));

function createCriterion(
  overrides: Partial<Section> & { content: string }
): Section {
  return {
    type: "testing_criterion",
    order: 0,
    done: false,
    done_at: null,
    ...overrides,
  };
}

describe("AcceptanceCriteria", () => {
  describe("empty state", () => {
    it("shows empty message when no criteria", () => {
      render(
        <AcceptanceCriteria
          criteria={[]}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      expect(
        screen.getByText("No test criteria defined")
      ).toBeInTheDocument();
    });
  });

  describe("progress summary", () => {
    it("shows correct count and percentage for mixed criteria", () => {
      const criteria = [
        createCriterion({
          content: "Met criterion",
          order: 0,
          done: true,
          done_at: "2024-01-01",
        }),
        createCriterion({
          content: "Pending criterion",
          order: 1,
          done: false,
          done_at: null,
        }),
        createCriterion({
          content: "Another met",
          order: 2,
          done: true,
          done_at: "2024-01-02",
        }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      expect(screen.getByText("2/3 met")).toBeInTheDocument();
      expect(screen.getByText("67%")).toBeInTheDocument();
    });

    it("shows 100% when all criteria met", () => {
      const criteria = [
        createCriterion({
          content: "Done 1",
          order: 0,
          done: true,
          done_at: "2024-01-01",
        }),
        createCriterion({
          content: "Done 2",
          order: 1,
          done: true,
          done_at: "2024-01-01",
        }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      expect(screen.getByText("2/2 met")).toBeInTheDocument();
      expect(screen.getByText("100%")).toBeInTheDocument();
    });

    it("shows 0% when no criteria met", () => {
      const criteria = [
        createCriterion({
          content: "Pending 1",
          order: 0,
          done: false,
          done_at: null,
        }),
        createCriterion({
          content: "Pending 2",
          order: 1,
          done: false,
          done_at: null,
        }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      expect(screen.getByText("0/2 met")).toBeInTheDocument();
      expect(screen.getByText("0%")).toBeInTheDocument();
    });
  });

  describe("status indicators", () => {
    it("met criteria have line-through text styling", () => {
      const criteria = [
        createCriterion({
          content: "Met criterion",
          order: 0,
          done: true,
          done_at: "2024-01-01",
        }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      const text = screen.getByText("Met criterion");
      expect(text.className).toContain("line-through");
      expect(text.className).toContain("text-[var(--color-fg-mute)]");
    });

    it("pending criteria do not have line-through styling", () => {
      const criteria = [
        createCriterion({
          content: "Pending criterion",
          order: 0,
          done: false,
          done_at: null,
        }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      const text = screen.getByText("Pending criterion");
      expect(text.className).not.toContain("line-through");
      expect(text.className).toContain("text-[var(--color-fg)]");
    });

    it("not-met criteria (done=false, done_at set) do not have line-through", () => {
      const criteria = [
        createCriterion({
          content: "Reverted criterion",
          order: 0,
          done: false,
          done_at: "2024-01-01",
        }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      const text = screen.getByText("Reverted criterion");
      expect(text.className).not.toContain("line-through");
    });

    it("met criterion has a transparent row and struck-through text", () => {
      const criteria = [
        createCriterion({
          content: "Met one",
          order: 0,
          done: true,
          done_at: "2024-01-01",
        }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      // Met state is conveyed by the accent checkbox + strikethrough text,
      // not a tinted row background (canonical Hearth styling).
      const text = screen.getByText("Met one");
      expect(text.className).toContain("line-through");
      const row = text.closest("div[class*='rounded-']");
      expect(row?.className).toContain("bg-transparent");
    });

    it("not-met criteria row has error background", () => {
      const criteria = [
        createCriterion({
          content: "Failed one",
          order: 0,
          done: false,
          done_at: "2024-01-01",
        }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      const row = screen
        .getByText("Failed one")
        .closest("div[class*='rounded-']");
      expect(row?.className).toContain("bg-[var(--color-err-wash)]");
    });
  });

  describe("validation badges", () => {
    it("shows no validation badge when criterion has no refs", () => {
      const criteria = [
        createCriterion({
          content: "No refs",
          order: 0,
        }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      // "human" was a fabricated label (absence of refs ≠ human validation).
      expect(screen.queryByText("human")).not.toBeInTheDocument();
      expect(screen.queryByText("machine")).not.toBeInTheDocument();
    });

    it("shows machine badge when criterion has refs", () => {
      const criteria = [
        createCriterion({
          content: "Machine validated",
          order: 0,
          refs: [
            {
              path: "tests/test.rs",
              line_start: 10,
              line_end: null,
              name: null,
              description: null,
            },
          ],
        }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      expect(screen.getByText("machine")).toBeInTheDocument();
    });

    it("shows code ref file names for machine-validated criteria", () => {
      const criteria = [
        createCriterion({
          content: "Tested criterion",
          order: 0,
          refs: [
            {
              path: "tests/integration/app_test.rs",
              line_start: 42,
              line_end: null,
              name: null,
              description: null,
            },
          ],
        }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      expect(screen.getByText("app_test.rs")).toBeInTheDocument();
      expect(screen.getByText("L42")).toBeInTheDocument();
    });
  });

  describe("toggle interaction", () => {
    it("calls toggleChecklistItemDone when criterion is clicked", async () => {
      const { commands } = await import("../../bindings");
      const onChanged = vi.fn();

      const criteria = [
        createCriterion({
          content: "Toggle me",
          order: 2,
          done: false,
        }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={onChanged}
        />
      );

      const toggleButton = screen.getByRole("button", {
        name: /mark criterion as met/i,
      });
      fireEvent.click(toggleButton);

      await waitFor(() => {
        expect(commands.toggleChecklistItemDone).toHaveBeenCalledWith(
          "task-1",
          2
        );
      });
    });
  });

  describe("ordering", () => {
    it("displays criteria sorted by order", () => {
      const criteria = [
        createCriterion({ content: "Third", order: 2 }),
        createCriterion({ content: "First", order: 0 }),
        createCriterion({ content: "Second", order: 1 }),
      ];

      render(
        <AcceptanceCriteria
          criteria={criteria}
          taskId="task-1"
          onSectionsChanged={vi.fn()}
        />
      );

      const items = screen.getAllByText(/First|Second|Third/);
      expect(items[0].textContent).toBe("First");
      expect(items[1].textContent).toBe("Second");
      expect(items[2].textContent).toBe("Third");
    });
  });
});
