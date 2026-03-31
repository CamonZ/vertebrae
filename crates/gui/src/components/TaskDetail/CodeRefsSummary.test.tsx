import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { CodeRefsSummary } from "./CodeRefsSummary";
import type { CodeRef } from "../../bindings";

describe("CodeRefsSummary", () => {
  describe("empty state", () => {
    it("shows empty message when no code refs", () => {
      render(<CodeRefsSummary codeRefs={[]} />);

      expect(screen.getByText("No code references")).toBeInTheDocument();
    });
  });

  describe("file display", () => {
    it("shows file name from path", () => {
      const refs: CodeRef[] = [
        {
          path: "src/components/App.tsx",
          line_start: null,
          line_end: null,
          name: null,
          description: null,
        },
      ];

      render(<CodeRefsSummary codeRefs={refs} />);

      expect(screen.getByText("App.tsx")).toBeInTheDocument();
    });

    it("shows line range when present", () => {
      const refs: CodeRef[] = [
        {
          path: "src/main.rs",
          line_start: 42,
          line_end: 50,
          name: null,
          description: null,
        },
      ];

      render(<CodeRefsSummary codeRefs={refs} />);

      expect(screen.getByText("main.rs")).toBeInTheDocument();
      expect(screen.getByText("L42-50")).toBeInTheDocument();
    });

    it("shows single line number when start equals end", () => {
      const refs: CodeRef[] = [
        {
          path: "src/lib.rs",
          line_start: 10,
          line_end: 10,
          name: null,
          description: null,
        },
      ];

      render(<CodeRefsSummary codeRefs={refs} />);

      expect(screen.getByText("L10")).toBeInTheDocument();
    });

    it("shows single line number when end is null", () => {
      const refs: CodeRef[] = [
        {
          path: "src/lib.rs",
          line_start: 10,
          line_end: null,
          name: null,
          description: null,
        },
      ];

      render(<CodeRefsSummary codeRefs={refs} />);

      expect(screen.getByText("L10")).toBeInTheDocument();
    });

    it("shows name when present", () => {
      const refs: CodeRef[] = [
        {
          path: "src/service.rs",
          line_start: 1,
          line_end: 100,
          name: "ServiceImpl",
          description: null,
        },
      ];

      render(<CodeRefsSummary codeRefs={refs} />);

      expect(screen.getByText("ServiceImpl")).toBeInTheDocument();
    });

    it("renders copy button for each ref", () => {
      const refs: CodeRef[] = [
        {
          path: "src/a.rs",
          line_start: null,
          line_end: null,
          name: null,
          description: null,
        },
        {
          path: "src/b.rs",
          line_start: null,
          line_end: null,
          name: null,
          description: null,
        },
      ];

      render(<CodeRefsSummary codeRefs={refs} />);

      const copyButtons = screen.getAllByRole("button", {
        name: /copy path/i,
      });
      expect(copyButtons).toHaveLength(2);
    });
  });

  describe("multiple refs", () => {
    it("renders all code refs", () => {
      const refs: CodeRef[] = [
        {
          path: "src/first.rs",
          line_start: null,
          line_end: null,
          name: null,
          description: null,
        },
        {
          path: "src/second.rs",
          line_start: null,
          line_end: null,
          name: null,
          description: null,
        },
        {
          path: "src/third.rs",
          line_start: null,
          line_end: null,
          name: null,
          description: null,
        },
      ];

      render(<CodeRefsSummary codeRefs={refs} />);

      expect(screen.getByText("first.rs")).toBeInTheDocument();
      expect(screen.getByText("second.rs")).toBeInTheDocument();
      expect(screen.getByText("third.rs")).toBeInTheDocument();
    });
  });
});
