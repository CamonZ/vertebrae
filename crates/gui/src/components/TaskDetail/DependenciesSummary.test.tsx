import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { DependenciesSummary } from "./DependenciesSummary";

describe("DependenciesSummary", () => {
  describe("empty state", () => {
    it("shows empty message when no dependencies", () => {
      render(
        <DependenciesSummary
          parentId={null}
          dependsOnIds={[]}
          dependentIds={[]}
        />
      );

      expect(screen.getByText("No dependencies")).toBeInTheDocument();
    });
  });

  describe("parent display", () => {
    it("shows parent task link when parentId is set", () => {
      render(
        <DependenciesSummary
          parentId="parent-task-id-full"
          dependsOnIds={[]}
          dependentIds={[]}
        />
      );

      expect(screen.getByText("Parent")).toBeInTheDocument();
      expect(screen.getByText("parent-t")).toBeInTheDocument();
    });

    it("clicking parent link calls onTaskSelect", () => {
      const onSelect = vi.fn();

      render(
        <DependenciesSummary
          parentId="parent-123"
          dependsOnIds={[]}
          dependentIds={[]}
          onTaskSelect={onSelect}
        />
      );

      const link = screen.getByText("parent-1");
      fireEvent.click(link);

      expect(onSelect).toHaveBeenCalledWith("parent-123");
    });
  });

  describe("blocked by display", () => {
    it("shows blocked by tasks", () => {
      render(
        <DependenciesSummary
          parentId={null}
          dependsOnIds={["abc12345-full-uuid", "xyz98765-full-uuid"]}
          dependentIds={[]}
        />
      );

      expect(screen.getByText("Blocked by")).toBeInTheDocument();
      // truncateId takes first 8 chars
      expect(screen.getByText("abc12345")).toBeInTheDocument();
      expect(screen.getByText("xyz98765")).toBeInTheDocument();
    });

    it("does not show blocked by when empty", () => {
      render(
        <DependenciesSummary
          parentId="parent-1"
          dependsOnIds={[]}
          dependentIds={[]}
        />
      );

      expect(screen.queryByText("Blocked by")).not.toBeInTheDocument();
    });
  });

  describe("blocking display", () => {
    it("shows blocking tasks", () => {
      render(
        <DependenciesSummary
          parentId={null}
          dependsOnIds={[]}
          dependentIds={["dependent-1-uuid"]}
        />
      );

      expect(screen.getByText("Blocking")).toBeInTheDocument();
      expect(screen.getByText("dependen")).toBeInTheDocument();
    });

    it("does not show blocking when empty", () => {
      render(
        <DependenciesSummary
          parentId="parent-1"
          dependsOnIds={[]}
          dependentIds={[]}
        />
      );

      expect(screen.queryByText("Blocking")).not.toBeInTheDocument();
    });
  });

  describe("navigation", () => {
    it("clicking any task link calls onTaskSelect with correct ID", () => {
      const onSelect = vi.fn();

      render(
        <DependenciesSummary
          parentId={null}
          dependsOnIds={["dep-1-full-uuid-here"]}
          dependentIds={["blocking-1-full-uuid"]}
          onTaskSelect={onSelect}
        />
      );

      const links = screen.getAllByRole("button");
      fireEvent.click(links[0]);

      expect(onSelect).toHaveBeenCalledTimes(1);
    });
  });
});
