import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventRow } from "./EventRow";
import type { AgentMessage } from "./types";

const rich = vi.hoisted(() => vi.fn());
vi.mock("../shared/MarkdownContent", () => ({
  MarkdownContent: ({text}: {text: string}) => { rich(text); return <div data-testid="rich">{text}</div>; },
  BoundedTextContent: () => null,
}));

const message: AgentMessage = {type: "agent", evt: "item", at: "", rel: "", prose: ""};
const chunks = ["  **bold**\n\n", "```ts\nconst a = 1;\n```\n", '{"nested": {"value": 1}}\n', "```mermaid\ngraph TD\nA --> B\n```\n", "<script>bad()</script>\tend  "];

describe("shared item completion boundary", () => {
  beforeEach(() => rich.mockClear());
  it("does no rich work for deltas and formats each completed item immediately", () => {
    const {container, rerender} = render(<EventRow {...message} lifecycle="streaming" />);
    let text = "";
    for (const chunk of chunks) {
      text += chunk;
      rerender(<EventRow {...message} lifecycle="streaming" prose={text} />);
      expect(container.querySelector(".evprose")?.textContent).toBe(text);
      expect(container.querySelector(".evprose--plain .ev-cursor")).not.toBeNull();
      expect(container.querySelector("script")).toBeNull();
      expect(rich).not.toHaveBeenCalled();
    }
    rerender(<><EventRow {...message} lifecycle="completed" prose={text} />
      <EventRow {...message} evt="other" lifecycle="streaming" prose="later **delta" /></>);
    expect(rich).toHaveBeenCalledExactlyOnceWith(text);
    expect(container.querySelectorAll(".ev-cursor")).toHaveLength(1);
  });
  it("keeps interrupted content literal without a cursor even with stale streaming flags", () => {
    const text = chunks.join("");
    const {container} = render(<EventRow {...message} lifecycle="interrupted" streaming prose={text} />);
    expect(container.querySelector(".evprose--plain")?.textContent).toBe(text);
    expect(container.querySelector(".ev-cursor")).toBeNull();
    expect(container.querySelector(".evtool-spin")).toBeNull();
    expect(rich).not.toHaveBeenCalled();
  });
  it("supports legacy streaming flags and keeps historical content rich", () => {
    const {rerender} = render(<EventRow {...message} streaming prose="**partial**" />);
    expect(rich).not.toHaveBeenCalled();
    rerender(<EventRow {...message} prose="**history**" />);
    expect(rich).toHaveBeenCalledExactlyOnceWith("**history**");
  });
});
