import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownContent } from "@/components/MarkdownContent";

describe("MarkdownContent", () => {
  it("renders plain text as a paragraph", () => {
    render(<MarkdownContent content="hello world" />);
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("renders bold text", () => {
    const { container } = render(<MarkdownContent content="**bold**" />);
    const strong = container.querySelector("strong");
    expect(strong).toBeInTheDocument();
    expect(strong!.textContent).toBe("bold");
  });

  it("renders inline code", () => {
    const { container } = render(<MarkdownContent content="use `console.log`" />);
    const code = container.querySelector("code");
    expect(code).toBeInTheDocument();
    expect(code!.textContent).toBe("console.log");
  });

  it("renders a code block without syntax highlighting", () => {
    const { container } = render(
      <MarkdownContent content={"```\nconst x = 1;\n```"} />,
    );
    const pre = container.querySelector("pre");
    expect(pre).toBeInTheDocument();
    const code = pre!.querySelector("code");
    expect(code!.textContent).toBe("const x = 1;\n");
  });

  it("renders a blockquote", () => {
    const { container } = render(<MarkdownContent content="> quoted text" />);
    const bq = container.querySelector("blockquote");
    expect(bq).toBeInTheDocument();
    expect(bq!.textContent).toContain("quoted text");
  });

  it("renders links with target=_blank", () => {
    render(<MarkdownContent content="[example](https://example.com)" />);
    const link = screen.getByText("example") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  it("replaces images with link text", () => {
    render(<MarkdownContent content="![alt text](https://img.png)" />);
    const link = screen.getByText("alt text") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://img.png");
  });

  it("renders GFM strikethrough", () => {
    const { container } = render(<MarkdownContent content="~~deleted~~" />);
    const del = container.querySelector("del");
    expect(del).toBeInTheDocument();
    expect(del!.textContent).toBe("deleted");
  });

  it("renders GFM task list", () => {
    const { container } = render(
      <MarkdownContent content={"- [x] done\n- [ ] todo"} />,
    );
    const checkboxes = container.querySelectorAll("input[type='checkbox']");
    expect(checkboxes.length).toBe(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it("highlights search matches in text nodes", () => {
    const { container } = render(
      <MarkdownContent content="hello world" searchQuery="world" />,
    );
    const mark = container.querySelector("mark");
    expect(mark).toBeInTheDocument();
    expect(mark!.textContent).toBe("world");
  });

  it("highlights search matches inside bold text", () => {
    const { container } = render(
      <MarkdownContent content="**important note**" searchQuery="important" />,
    );
    const mark = container.querySelector("mark");
    expect(mark).toBeInTheDocument();
    expect(mark!.textContent).toBe("important");
    // mark should be inside strong
    expect(mark!.closest("strong")).toBeInTheDocument();
  });

  it("does not highlight when searchQuery is shorter than 3 chars", () => {
    const { container } = render(
      <MarkdownContent content="hello world" searchQuery="he" />,
    );
    const mark = container.querySelector("mark");
    expect(mark).toBeNull();
  });

  it("does not highlight when searchQuery is empty", () => {
    const { container } = render(
      <MarkdownContent content="hello world" searchQuery="" />,
    );
    const mark = container.querySelector("mark");
    expect(mark).toBeNull();
  });
});
