import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { VtbEntityLink, VtbEntityMarkdownLink } from "./VtbEntityLink";
import { parseVtbEntityHref } from "./vtbEntityLinkTarget";

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

describe("parseVtbEntityHref", () => {
  it("parses task-level entity links into routes and level metadata", () => {
    const target = parseVtbEntityHref(
      "vtb://ticket/03111754-4769-47c1-a64c-078d73554af8"
    );

    expect(target).toMatchObject({
      type: "ticket",
      id: "03111754-4769-47c1-a64c-078d73554af8",
      route: "/task/03111754-4769-47c1-a64c-078d73554af8",
      level: "ticket",
    });
  });

  it("maps non-task entities to their existing GUI routes", () => {
    expect(parseVtbEntityHref("vtb://step/step-1")?.route).toBe(
      "/design?stepId=step-1"
    );
    expect(parseVtbEntityHref("vtb://workflow/wf-1")?.route).toBe(
      "/design?workflowId=wf-1"
    );
    expect(parseVtbEntityHref("vtb://project/my-project")?.route).toBe(
      "/setup?project=my-project"
    );
  });

  it("rejects unknown or malformed vtb links", () => {
    expect(parseVtbEntityHref("vtb://unknown/id")).toBeNull();
    expect(parseVtbEntityHref("vtb://ticket")).toBeNull();
    expect(parseVtbEntityHref("vtb://ticket/")).toBeNull();
    expect(parseVtbEntityHref("vtb://ticket/id/extra")).toBeNull();
    expect(parseVtbEntityHref("vtb://ticket/%E0%A4%A")).toBeNull();
  });
});

describe("VtbEntityLink", () => {
  it("renders one readable label and opens through the supplied callback", async () => {
    const user = userEvent.setup();
    const target = parseVtbEntityHref(
      "vtb://ticket/03111754-4769-47c1-a64c-078d73554af8"
    );
    const onOpen = vi.fn();

    render(
      <VtbEntityLink target={target!} onOpen={onOpen}>
        Ticket 03111754
      </VtbEntityLink>
    );

    const link = screen.getByRole("link", { name: /open ticket/i });
    expect(link).toHaveAttribute("data-vtb-entity-type", "ticket");
    expect(screen.getByTestId("vtb-entity-level-mark")).toHaveAttribute(
      "data-level",
      "ticket"
    );
    expect(link).toHaveTextContent("Ticket 03111754");
    expect(link).toHaveAttribute(
      "data-full-id",
      "03111754-4769-47c1-a64c-078d73554af8"
    );
    expect(screen.queryByTestId("vtb-entity-id-chip")).toBeNull();

    await user.click(link);

    expect(onOpen).toHaveBeenCalledWith(target);
  });

  it("does not navigate away for project links in a routed chat surface", async () => {
    const user = userEvent.setup();
    const target = parseVtbEntityHref("vtb://project/my-project");

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <VtbEntityMarkdownLink target={target!}>
          Project setup
        </VtbEntityMarkdownLink>
        <LocationProbe />
      </MemoryRouter>
    );

    await user.click(screen.getByRole("link", { name: /open project/i }));

    expect(screen.getByTestId("location")).toHaveTextContent("/chat");
  });
});
