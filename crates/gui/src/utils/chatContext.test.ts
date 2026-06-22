import { describe, expect, it } from "vitest";
import { scopeLabel } from "./chatContext";

describe("scopeLabel", () => {
  it("returns Project for project scope", () => {
    expect(scopeLabel("project")).toBe("Project");
  });

  it("returns Workflow for workflow scope", () => {
    expect(scopeLabel("workflow")).toBe("Workflow");
  });

  it("returns Task for task scope", () => {
    expect(scopeLabel("task")).toBe("Task");
  });

  it("returns Step for step scope", () => {
    expect(scopeLabel("step")).toBe("Step");
  });
});
