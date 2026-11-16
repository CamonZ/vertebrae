import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { PanelCode } from "./PanelCode";

vi.mock("./PierrePanelCode", () => ({
  default: () => {
    throw new Error("Unavailable renderer");
  },
}));

describe("PanelCode recovery", () => {
  it("retains exact editable drafts and errors after renderer failure", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    function Draft() {
      const [source, setSource] = useState("{\ninvalid\n}");
      return (
        <PanelCode
          source={source}
          onChange={setSource}
          label="Route config"
          language="json"
          error="Invalid JSON"
        />
      );
    }
    try {
      render(<Draft />);
      await waitFor(() => expect(consoleError).toHaveBeenCalled());
      const input = await screen.findByRole("textbox", {
        name: "Route config",
      });
      expect(input).toHaveValue("{\ninvalid\n}");
      fireEvent.change(input, { target: { value: '{"valid": true}' } });
      expect(input).toHaveValue('{"valid": true}');
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAttribute("aria-description", "Invalid JSON");
    } finally {
      consoleError.mockRestore();
    }
  });
  it("keeps read-only source available after failure", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      render(
        <PanelCode
          source={'{"value": 42}'}
          label="Artifact JSON"
          language="json"
        />
      );
      await waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect(await screen.findByText('{"value": 42}')).toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});
