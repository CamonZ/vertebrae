import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MarkdownContent } from "./MarkdownContent";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMock,
}));

// Mock scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

describe("MarkdownContent", () => {
  beforeEach(() => {
    mermaidMock.initialize.mockClear();
    mermaidMock.parse.mockReset();
    mermaidMock.render.mockReset();
    mermaidMock.parse.mockResolvedValue(true);
    mermaidMock.render.mockResolvedValue({
      svg: '<svg viewBox="0 0 100 40" onload="alert(1)"><text>A --&gt; B</text><script>alert("x")</script></svg>',
    });
  });

  describe("plain text rendering", () => {
    it("renders plain text in a paragraph", () => {
      render(<MarkdownContent text="Hello world" />);
      const paragraph = screen.getByText("Hello world");
      expect(paragraph.tagName).toBe("P");
    });

    it("wraps content in a container with data-testid", () => {
      render(<MarkdownContent text="test" />);
      expect(screen.getByTestId("markdown-content")).toBeInTheDocument();
    });
  });

  describe("inline formatting", () => {
    it("renders bold text with strong tag", () => {
      render(<MarkdownContent text="This is **bold** text" />);
      const strong = screen.getByText("bold");
      expect(strong.tagName).toBe("STRONG");
      expect(strong.className).toContain("font-semibold");
    });

    it("renders italic text with em tag", () => {
      render(<MarkdownContent text="This is *italic* text" />);
      const em = screen.getByText("italic");
      expect(em.tagName).toBe("EM");
    });

    it("renders inline emphasis as serif italic at full --fg (not copper)", () => {
      // Cursive role B: inline prose <em> is Newsreader serif italic at full
      // --fg. It must be visually distinct from a heading accent word (copper).
      render(<MarkdownContent text="This is *emphasised* text" />);
      const em = screen.getByText("emphasised");
      expect(em.tagName).toBe("EM");
      expect(em.className).toContain("font-serif");
      expect(em.className).toContain("italic");
      expect(em.className).toContain("text-[var(--color-fg)]");
      // Explicitly NOT the copper accent used for heading accent words.
      expect(em.className).not.toContain("var(--color-accent)");
    });

    it("renders inline code with code tag and mono font", () => {
      render(<MarkdownContent text="Use `console.log()` here" />);
      const code = screen.getByText("console.log()");
      expect(code.tagName).toBe("CODE");
      expect(code.className).toContain("font-mono");
      expect(code.className).toContain("text-accent");
    });
  });

  describe("headings", () => {
    it("renders h1 headings", () => {
      render(<MarkdownContent text="# Main Title" />);
      const heading = screen.getByText("Main Title");
      expect(heading.tagName).toBe("H1");
      expect(heading.className).toContain("text-xl");
      expect(heading.className).toContain("font-bold");
    });

    it("renders h2 headings", () => {
      render(<MarkdownContent text="## Section Title" />);
      const heading = screen.getByText("Section Title");
      expect(heading.tagName).toBe("H2");
      expect(heading.className).toContain("font-semibold");
    });

    it("renders h3 headings", () => {
      render(<MarkdownContent text="### Subsection" />);
      const heading = screen.getByText("Subsection");
      expect(heading.tagName).toBe("H3");
    });

    it("renders h4 headings", () => {
      render(<MarkdownContent text="#### Detail" />);
      const heading = screen.getByText("Detail");
      expect(heading.tagName).toBe("H4");
      expect(heading.className).toContain("font-semibold");
    });
  });

  describe("lists", () => {
    it("renders unordered lists with disc style", () => {
      render(<MarkdownContent text={"- Item one\n- Item two\n- Item three"} />);
      expect(screen.getByText("Item one")).toBeInTheDocument();
      expect(screen.getByText("Item two")).toBeInTheDocument();
      expect(screen.getByText("Item three")).toBeInTheDocument();

      const list = screen.getByText("Item one").closest("ul");
      expect(list).not.toBeNull();
      expect(list!.className).toContain("list-disc");
    });

    it("renders ordered lists with decimal style", () => {
      render(<MarkdownContent text={"1. First\n2. Second\n3. Third"} />);
      expect(screen.getByText("First")).toBeInTheDocument();
      const list = screen.getByText("First").closest("ol");
      expect(list).not.toBeNull();
      expect(list!.className).toContain("list-decimal");
    });
  });

  describe("links", () => {
    it("renders links with target=_blank and rel attributes", () => {
      render(<MarkdownContent text="Visit [Example](https://example.com)" />);
      const link = screen.getByText("Example");
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", "https://example.com");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });
  });

  describe("blockquotes", () => {
    it("renders blockquotes with left border styling", () => {
      render(<MarkdownContent text="> This is a quote" />);
      const quote = screen.getByText("This is a quote").closest("blockquote");
      expect(quote).not.toBeNull();
      expect(quote!.className).toContain("border-l-2");
      expect(quote!.className).toContain("italic");
    });
  });

  describe("code blocks", () => {
    it("renders fenced code blocks with language label", () => {
      const markdown = "```typescript\nconst x = 42;\n```";
      const { container } = render(<MarkdownContent text={markdown} />);
      expect(screen.getByText("typescript")).toBeInTheDocument();
      // Syntax highlighter splits tokens across spans, so check the code element's text content
      const codeEl = container.querySelector("code");
      expect(codeEl).not.toBeNull();
      expect(codeEl!.textContent).toContain("const");
      expect(codeEl!.textContent).toContain("42");
    });

    it("renders fenced code blocks without language and no language label", () => {
      const markdown = "```\nplain code\n```";
      const { container } = render(<MarkdownContent text={markdown} />);
      expect(screen.getByText("plain code")).toBeInTheDocument();
      // Should not render a language label bar
      const languageLabel = container.querySelector(
        ".font-mono.text-\\[11px\\]"
      );
      expect(languageLabel).toBeNull();
    });

    it("renders multi-line code blocks with exact content", () => {
      const markdown = "```js\nline1\nline2\nline3\n```";
      const { container } = render(<MarkdownContent text={markdown} />);
      expect(screen.getByText("js")).toBeInTheDocument();
      const codeEl = container.querySelector("code");
      expect(codeEl).not.toBeNull();
      // Trailing newline should be stripped, content should be exact
      expect(codeEl!.textContent).toBe("line1\nline2\nline3");
    });

    it("renders a completed Mermaid fence as a sandboxed diagram", async () => {
      const markdown = "```mermaid\ngraph TD\n  A --> B\n```";
      render(<MarkdownContent text={markdown} />);

      const frame = await screen.findByTitle("Mermaid diagram");
      expect(frame).toHaveAttribute("sandbox", "");
      expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("<svg"));
      expect(frame).toHaveAttribute(
        "srcdoc",
        expect.not.stringContaining("<script>")
      );
      expect(frame).toHaveAttribute(
        "srcdoc",
        expect.not.stringContaining("onload")
      );
      expect(mermaidMock.parse).toHaveBeenCalledWith("graph TD\n  A --> B");
      expect(mermaidMock.render).toHaveBeenCalledWith(
        expect.stringMatching(/^diagram-/),
        "graph TD\n  A --> B"
      );
      expect(screen.queryByTestId("diagram-fallback")).toBeNull();
    });

    it("falls back to highlighted source with an error for invalid Mermaid", async () => {
      mermaidMock.parse.mockRejectedValueOnce(new Error("Parse error"));
      const markdown = "```mermaid\ngraph TD\n  A -- B\n```";
      const { container } = render(<MarkdownContent text={markdown} />);

      expect(
        await screen.findByText("Unable to render Mermaid diagram: Parse error")
      ).toBeInTheDocument();
      expect(screen.queryByTitle("Mermaid diagram")).toBeNull();
      expect(screen.getByTestId("diagram-fallback")).toBeInTheDocument();
      const codeEl = container.querySelector("code");
      expect(codeEl).not.toBeNull();
      expect(codeEl!.textContent).toBe("graph TD\n  A -- B");
    });

    it("falls back to highlighted source with an error for unsupported diagram languages", async () => {
      const markdown = "```dot\ndigraph { A -> B }\n```";
      const { container } = render(<MarkdownContent text={markdown} />);

      expect(
        await screen.findByText("DOT diagrams are not supported yet.")
      ).toBeInTheDocument();
      expect(mermaidMock.parse).not.toHaveBeenCalled();
      const codeEl = container.querySelector("code");
      expect(codeEl).not.toBeNull();
      expect(codeEl!.textContent).toBe("digraph { A -> B }");
    });
  });

  describe("tables (GFM)", () => {
    it("renders GFM tables with proper structure", () => {
      const markdown =
        "| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |";
      render(<MarkdownContent text={markdown} />);

      expect(screen.getByText("Name")).toBeInTheDocument();
      expect(screen.getByText("Value")).toBeInTheDocument();
      expect(screen.getByText("Alpha")).toBeInTheDocument();
      expect(screen.getByText("1")).toBeInTheDocument();
      expect(screen.getByText("Beta")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();

      const nameHeader = screen.getByText("Name");
      expect(nameHeader.tagName).toBe("TH");
      expect(nameHeader.className).toContain("font-medium");

      const alphaCell = screen.getByText("Alpha");
      expect(alphaCell.tagName).toBe("TD");
    });
  });

  describe("horizontal rules", () => {
    it("renders horizontal rules", () => {
      const { container } = render(
        <MarkdownContent text={"Above\n\n---\n\nBelow"} />
      );
      const hr = container.querySelector("hr");
      expect(hr).not.toBeNull();
      expect(hr!.className).toContain("border-border");
    });
  });

  describe("streaming / partial markdown", () => {
    it("renders unclosed code fence without breaking", () => {
      const partial = "Here is code:\n```python\ndef hello():";
      const { container } = render(<MarkdownContent text={partial} />);
      expect(
        container.querySelector('[data-testid="markdown-content"]')
      ).toBeInTheDocument();
      // Syntax highlighter splits tokens, so check via code element text content
      const codeEl = container.querySelector("code");
      expect(codeEl).not.toBeNull();
      expect(codeEl!.textContent).toContain("def");
      expect(codeEl!.textContent).toContain("hello");
    });

    it("does not render or report errors for unclosed Mermaid fences", async () => {
      const partial = "Here is a diagram:\n```mermaid\ngraph TD\n  A -->";
      const { container } = render(<MarkdownContent text={partial} />);

      expect(
        container.querySelector('[data-testid="markdown-content"]')
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(mermaidMock.parse).not.toHaveBeenCalled();
      });
      expect(screen.queryByTitle("Mermaid diagram")).toBeNull();
      expect(screen.queryByTestId("diagram-fallback")).toBeNull();
      const codeEl = container.querySelector("code");
      expect(codeEl).not.toBeNull();
      expect(codeEl!.textContent).toContain("graph TD");
      expect(codeEl!.textContent).toContain("A -->");
    });

    it("renders partial bold syntax without breaking", () => {
      const partial = "This is **bold but not clo";
      const { container } = render(<MarkdownContent text={partial} />);
      expect(
        container.querySelector('[data-testid="markdown-content"]')
      ).toBeInTheDocument();
    });

    it("renders partial list without breaking", () => {
      const partial = "Items:\n- First\n- Second\n- ";
      const { container } = render(<MarkdownContent text={partial} />);
      expect(
        container.querySelector('[data-testid="markdown-content"]')
      ).toBeInTheDocument();
      expect(screen.getByText("First")).toBeInTheDocument();
      expect(screen.getByText("Second")).toBeInTheDocument();
    });

    it("renders empty text without breaking", () => {
      const { container } = render(<MarkdownContent text="" />);
      expect(
        container.querySelector('[data-testid="markdown-content"]')
      ).toBeInTheDocument();
    });
  });

  describe("complex markdown", () => {
    it("renders a mix of headings, lists, code, and text", () => {
      const markdown = [
        "## Overview",
        "",
        "This function does the following:",
        "",
        "1. Reads the file",
        "2. Parses the content",
        "3. Returns the result",
        "",
        "Example:",
        "",
        "```rust",
        "fn main() {",
        '    println!("hello");',
        "}",
        "```",
        "",
        "Use `main()` to start.",
      ].join("\n");

      render(<MarkdownContent text={markdown} />);

      expect(screen.getByText("Overview")).toBeInTheDocument();
      expect(screen.getByText("Overview").tagName).toBe("H2");
      expect(screen.getByText("Reads the file")).toBeInTheDocument();
      expect(screen.getByText("rust")).toBeInTheDocument();
      expect(screen.getByText("main()")).toBeInTheDocument();
      expect(screen.getByText("main()").tagName).toBe("CODE");
    });

    it("renders GFM strikethrough text", () => {
      render(<MarkdownContent text="This is ~~deleted~~ text" />);
      const deleted = screen.getByText("deleted");
      expect(deleted.tagName).toBe("DEL");
    });

    it("renders GFM task lists", () => {
      const markdown = "- [x] Done\n- [ ] Not done";
      render(<MarkdownContent text={markdown} />);
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.getByText("Not done")).toBeInTheDocument();
    });
  });

  describe("inline JSON pretty-printing", () => {
    function jsonCodeText(): string {
      const container = screen.getByTestId("markdown-content");
      // Syntax highlighter splits tokens across spans; flatten to text.
      const code = container.querySelector("code");
      return code?.textContent ?? "";
    }

    it("hoists inline JSON in prose into a pretty-printed code block", () => {
      const message =
        'Here is the result: {"key":"value","nested":{"a":1,"b":2}} done.';
      render(<MarkdownContent text={message} />);
      const rendered = jsonCodeText();
      expect(rendered).toContain('"key": "value"');
      expect(rendered).toContain('"nested": {');
      // Multi-line indication: more than one newline post-format.
      expect(rendered.split("\n").length).toBeGreaterThan(2);
    });

    it("hoists inline JSON arrays from prose", () => {
      const message = 'Got [{"id":1,"v":"a"},{"id":2,"v":"b"}] back.';
      render(<MarkdownContent text={message} />);
      const rendered = jsonCodeText();
      expect(rendered).toContain('"id": 1');
      expect(rendered).toContain('"v": "a"');
    });

    it("leaves prose untouched when no JSON is present", () => {
      render(<MarkdownContent text="No json here, just words {and braces}." />);
      // `{and braces}` is not valid JSON; should not become a code block.
      expect(
        screen.getByTestId("markdown-content").querySelector("pre")
      ).toBeNull();
    });

    it("skips JSON inside existing fenced code blocks", () => {
      const message = '```json\n{"already":"fenced"}\n```\nFollow-up text.';
      render(<MarkdownContent text={message} />);
      // Only one code block — the existing fence — not double-wrapped.
      const preBlocks = screen
        .getByTestId("markdown-content")
        .querySelectorAll("pre");
      expect(preBlocks.length).toBe(1);
    });

    it("skips JSON inside inline code spans", () => {
      const message = 'Use `{"raw":"json"}` literally.';
      render(<MarkdownContent text={message} />);
      // No code BLOCK (pre) — only the inline code span.
      const preBlocks = screen
        .getByTestId("markdown-content")
        .querySelectorAll("pre");
      expect(preBlocks.length).toBe(0);
    });

    it("does not wrap empty objects or arrays", () => {
      render(<MarkdownContent text="Got back {} or []." />);
      const preBlocks = screen
        .getByTestId("markdown-content")
        .querySelectorAll("pre");
      expect(preBlocks.length).toBe(0);
    });

    it("ignores brace-like prose that isn't valid JSON", () => {
      render(
        <MarkdownContent text='Template like {name: "foo", id: bar} is not JSON.' />
      );
      const preBlocks = screen
        .getByTestId("markdown-content")
        .querySelectorAll("pre");
      expect(preBlocks.length).toBe(0);
    });

    it("handles JSON containing strings with braces correctly", () => {
      const message =
        'Result: {"label":"contains {nested} text","ok":true} after.';
      render(<MarkdownContent text={message} />);
      const rendered = jsonCodeText();
      expect(rendered).toContain('"label": "contains {nested} text"');
      expect(rendered).toContain('"ok": true');
    });

    it("hoists multiple inline JSON blocks in the same message", () => {
      const message =
        'First {"a":1,"b":2} and second [{"x":10},{"x":20}] done.';
      render(<MarkdownContent text={message} />);
      const preBlocks = screen
        .getByTestId("markdown-content")
        .querySelectorAll("pre");
      expect(preBlocks.length).toBe(2);
    });

    it("pretty-prints Elixir map syntax in a json fence", () => {
      // Sacrum (Elixir) often emits maps with `=>` separators when an
      // agent quotes a payload back at the user.
      const message =
        '```json\n%{"additionalProperties" => false, "properties" => %{"failed" => %{"items" => %{"type" => "string"}}}}\n```';
      render(<MarkdownContent text={message} />);
      const rendered = jsonCodeText();
      expect(rendered).toContain('"additionalProperties": false');
      expect(rendered).toContain('"properties": {');
      expect(rendered).toContain('"items": {');
      // Multi-line: at least one nested key on its own indented line.
      expect(rendered.split("\n").length).toBeGreaterThan(4);
    });

    it("pretty-prints Elixir maps that use the unicode ⇒ separator", () => {
      const message = '```json\n%{"a" ⇒ 1, "b" ⇒ %{"c" ⇒ 2}}\n```';
      render(<MarkdownContent text={message} />);
      const rendered = jsonCodeText();
      expect(rendered).toContain('"a": 1');
      expect(rendered).toContain('"b": {');
      expect(rendered).toContain('"c": 2');
    });

    it("hoists bare Elixir maps just like bare JSON", () => {
      // No fence: maybeWrapBareJson should pick up `%{...}` content.
      const message = '%{"id" => "abc-123", "ok" => true, "n" => 42}';
      render(<MarkdownContent text={message} />);
      const rendered = jsonCodeText();
      expect(rendered).toContain('"id": "abc-123"');
      expect(rendered).toContain('"ok": true');
      expect(rendered).toContain('"n": 42');
    });

    it("does not mangle JSON strings that contain => or ⇒", () => {
      // String value contains `=>` — must NOT be replaced with `:`.
      const message = '```json\n{"comment": "a => b", "ok": true}\n```';
      render(<MarkdownContent text={message} />);
      const rendered = jsonCodeText();
      expect(rendered).toContain('"comment": "a => b"');
      expect(rendered).toContain('"ok": true');
    });

    it("leaves Elixir maps with atom keys untouched", () => {
      // `%{status: :ok}` uses atom shorthand which we don't translate;
      // JSON.parse fails on the conversion so the source is preserved.
      const message = "```json\n%{status: :ok, count: 3}\n```";
      const { container } = render(<MarkdownContent text={message} />);
      const code = container.querySelector("code");
      expect(code?.textContent).toContain("%{status: :ok, count: 3}");
    });
  });
});
