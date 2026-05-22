import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StyleguidePage } from "./StyleguidePage";

describe("StyleguidePage", () => {
  it("renders representative examples without backend data", () => {
    render(
      <MemoryRouter>
        <StyleguidePage />
      </MemoryRouter>
    );

    expect(
      screen.getByRole("heading", { name: "GUI Styleguide" })
    ).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: "Visual Tokens" })
    ).toBeInTheDocument();
    expect(screen.getByText("Primary")).toBeInTheDocument();
    expect(screen.getByText("Accent")).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: "Product Frame" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Sidebar navigation")).toBeInTheDocument();
    expect(screen.getByText("App shell content header")).toBeInTheDocument();
    expect(screen.getByText("Workflow Details")).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: "Workflow Diagramming System" })
    ).toBeInTheDocument();
    expect(screen.getByText("Workflow Container")).toBeInTheDocument();
    expect(screen.getByText("Step Cards")).toBeInTheDocument();
    expect(screen.getByText("Pipeline Background")).toBeInTheDocument();
    expect(screen.getByTestId("step-node-todo")).toBeInTheDocument();
    expect(screen.getByTestId("step-node-pending_review")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-zone-id")).toBeInTheDocument();

    const navigation = screen.getByRole("heading", { name: "Navigation" })
      .parentElement as HTMLElement;
    expect(
      within(navigation).getByLabelText("Styleguide navigation example")
    ).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: "Buttons And Forms" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Primary action" })
    ).toBeInTheDocument();
    expect(
      screen.getAllByDisplayValue("Review waiting gate display").length
    ).toBeGreaterThan(0);

    expect(
      screen.getByRole("heading", { name: "Badges And IDs" })
    ).toBeInTheDocument();
    expect(screen.getByText("workflow")).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: "Panels And Trace Displays" })
    ).toBeInTheDocument();
    expect(screen.getByText("Waiting on human input")).toBeInTheDocument();
    expect(
      screen.getAllByText("Review operator handoff flow").length
    ).toBeGreaterThan(0);

    expect(
      screen.getByRole("heading", { name: "Form Components" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("TextField")).toBeInTheDocument();
    expect(screen.getByLabelText("SelectField")).toBeInTheDocument();
    expect(screen.getByLabelText("TextareaField")).toBeInTheDocument();
    expect(screen.getByText("TagField")).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: "Controls And Feedback" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Primary toggle" })
    ).toBeInTheDocument();
    expect(screen.getByText("Delete Task?")).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: "Shared Display Components" })
    ).toBeInTheDocument();
    expect(screen.getByText("Review Summary")).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: "Task And Workflow Components" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Task: Review operator handoff flow" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /View workflow: Implementation/ })
    ).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: "Trace And Workflow Utilities" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("trace-mode-toggle")).toBeInTheDocument();
    expect(screen.getAllByTestId("event-glyph")).toHaveLength(3);
    expect(screen.getByTestId("liquid-highlight")).toBeInTheDocument();
  });
});
