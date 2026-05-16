import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createMockTask } from "../../test/test-utils";
import { TaskPicker, filterTasksForPicker } from "./TaskPicker";

const tasks = [
  createMockTask({ id: "abcd1234-aaaa", title: "Refactor router" }),
  createMockTask({ id: "ef567890-bbbb", title: "Add Traces nav" }),
  createMockTask({
    id: "12345678-cccc",
    title: "Fix typo in UI",
    description: "Trace picker description needle",
  }),
];

describe("filterTasksForPicker", () => {
  it("returns all tasks for empty query", () => {
    expect(filterTasksForPicker(tasks, "")).toHaveLength(3);
    expect(filterTasksForPicker(tasks, "   ")).toHaveLength(3);
  });

  it("matches by case-insensitive title substring", () => {
    const results = filterTasksForPicker(tasks, "ROUTER");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Refactor router");
  });

  it("matches by id prefix", () => {
    const results = filterTasksForPicker(tasks, "abcd1234");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("abcd1234-aaaa");
  });

  it("matches by case-insensitive description substring", () => {
    const results = filterTasksForPicker(tasks, "DESCRIPTION NEEDLE");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("12345678-cccc");
  });

  it("matches by full id", () => {
    const results = filterTasksForPicker(tasks, "ef567890-bbbb");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("ef567890-bbbb");
  });

  it("does not match id substrings beyond the prefix", () => {
    // Only full ids and 8-character short ids match, not arbitrary fragments.
    const results = filterTasksForPicker(tasks, "1234");
    expect(results).toHaveLength(0);
  });
});

describe("TaskPicker component", () => {
  it("renders the input and list of tasks", () => {
    render(<TaskPicker tasks={tasks} onSelect={vi.fn()} />);
    expect(screen.getByTestId("task-picker-input")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("filters by title as the user types", () => {
    render(<TaskPicker tasks={tasks} onSelect={vi.fn()} />);
    const input = screen.getByTestId("task-picker-input");
    fireEvent.change(input, { target: { value: "traces" } });
    const opts = screen.getAllByRole("option");
    expect(opts).toHaveLength(1);
    expect(opts[0]).toHaveTextContent("Add Traces nav");
  });

  it("Enter calls onSelect with the highlighted task id", () => {
    const onSelect = vi.fn();
    render(<TaskPicker tasks={tasks} onSelect={onSelect} />);
    const input = screen.getByTestId("task-picker-input");
    // First task is highlighted by default
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("abcd1234-aaaa");
  });

  it("ArrowDown moves highlight, Enter selects the new one", () => {
    const onSelect = vi.fn();
    render(<TaskPicker tasks={tasks} onSelect={onSelect} />);
    const input = screen.getByTestId("task-picker-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("12345678-cccc");
  });

  it("ArrowUp does not move past the first item", () => {
    const onSelect = vi.fn();
    render(<TaskPicker tasks={tasks} onSelect={onSelect} />);
    const input = screen.getByTestId("task-picker-input");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("abcd1234-aaaa");
  });

  it("Esc clears the query when there is one", () => {
    render(<TaskPicker tasks={tasks} onSelect={vi.fn()} />);
    const input = screen.getByTestId("task-picker-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "router" } });
    expect(input.value).toBe("router");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });

  it("clicking an option calls onSelect with that task's id", () => {
    const onSelect = vi.fn();
    render(<TaskPicker tasks={tasks} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("task-picker-option-ef567890-bbbb"));
    expect(onSelect).toHaveBeenCalledWith("ef567890-bbbb");
  });

  it("shows an empty-state message when no tasks match", () => {
    render(<TaskPicker tasks={tasks} onSelect={vi.fn()} />);
    fireEvent.change(screen.getByTestId("task-picker-input"), {
      target: { value: "zzzznomatch" },
    });
    expect(screen.getByTestId("task-picker-empty")).toHaveTextContent(
      "No tasks match your search."
    );
  });

  it("Enter with no matches does not call onSelect", () => {
    const onSelect = vi.fn();
    render(<TaskPicker tasks={tasks} onSelect={onSelect} />);
    const input = screen.getByTestId("task-picker-input");
    fireEvent.change(input, { target: { value: "zzz" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
