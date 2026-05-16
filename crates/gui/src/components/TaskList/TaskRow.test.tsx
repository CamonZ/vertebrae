import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMockTask } from "../../test/test-utils";
import { TaskRow } from "./TaskRow";

describe("TaskRow", () => {
  it("renders task IDs as eight-character IDs derived from the full UUID", () => {
    render(
      <table>
        <tbody>
          <TaskRow
            task={createMockTask({
              id: "abcdef12-3456-7890-abcd-ef1234567890",
              title: "Derived ID task",
            })}
          />
        </tbody>
      </table>
    );

    expect(screen.getByTestId("task-row-id")).toHaveTextContent("abcdef12");
    expect(screen.getByTestId("task-row-id")).toHaveAttribute(
      "data-full-id",
      "abcdef12-3456-7890-abcd-ef1234567890"
    );
  });
});
