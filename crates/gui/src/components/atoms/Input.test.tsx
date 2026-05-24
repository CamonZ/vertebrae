import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Input, Textarea } from "./Input";

describe("Input", () => {
  it("accepts typed text", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="name" />);
    const input = screen.getByLabelText("name");
    await user.type(input, "hello");
    expect(input).toHaveValue("hello");
  });

  it("marks aria-invalid when invalid", () => {
    render(<Input aria-label="x" invalid />);
    expect(screen.getByLabelText("x")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("Textarea", () => {
  it("renders with multi-line content", () => {
    render(<Textarea aria-label="desc" defaultValue={"one\ntwo"} />);
    expect(screen.getByLabelText("desc")).toHaveValue("one\ntwo");
  });

  it("caps height via maxRows", () => {
    const { container } = render(<Textarea aria-label="desc" maxRows={3} />);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta.style.maxHeight).toBeTruthy();
  });
});
