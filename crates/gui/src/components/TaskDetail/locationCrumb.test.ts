import { describe, expect, it } from "vitest";
import { locationCrumb } from "./locationCrumb";

describe("locationCrumb", () => {
  it("shows identical workflow and step labels once", () => {
    expect(locationCrumb("Backlog", "Backlog")).toBe("Backlog");
  });
  it("joins distinct labels", () => {
    expect(locationCrumb("Delivery", "In progress")).toBe(
      "Delivery › In progress"
    );
  });
});
