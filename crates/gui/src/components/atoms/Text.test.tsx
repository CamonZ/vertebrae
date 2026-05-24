import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Text } from "./Text";

describe("Text", () => {
  it("renders the default element for a variant (heading-lg → h2)", () => {
    render(<Text variant="heading-lg">Title</Text>);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Title");
  });

  it("accepts an explicit as override", () => {
    render(
      <Text variant="body" as="strong">
        bold
      </Text>,
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
  });
});
