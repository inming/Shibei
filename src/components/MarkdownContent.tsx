import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { Root, Text, Element, ElementContent } from "hast";
import styles from "./MarkdownContent.module.css";

interface MarkdownContentProps {
  content: string;
  searchQuery?: string;
}

function rehypeHighlight(query: string) {
  const lowerQuery = query.toLowerCase();
  return () => (tree: Root) => {
    visit(tree);
  };

  function visit(node: Root | Element) {
    const newChildren: ElementContent[] = [];
    for (const child of node.children) {
      if (child.type === "text") {
        const parts = splitText(child, lowerQuery);
        newChildren.push(...parts);
      } else if (child.type === "element") {
        visit(child);
        newChildren.push(child);
      } else {
        newChildren.push(child as ElementContent);
      }
    }
    node.children = newChildren;
  }

  function splitText(node: Text, lq: string): ElementContent[] {
    const text = node.value;
    const lower = text.toLowerCase();
    const idx = lower.indexOf(lq);
    if (idx === -1) return [node];

    const results: ElementContent[] = [];
    if (idx > 0) {
      results.push({ type: "text", value: text.slice(0, idx) });
    }
    results.push({
      type: "element",
      tagName: "mark",
      properties: {},
      children: [{ type: "text", value: text.slice(idx, idx + lq.length) }],
    });
    const rest = text.slice(idx + lq.length);
    if (rest) {
      results.push({ type: "text", value: rest });
    }
    return results;
  }
}

const baseComponents: Components = {
  img: ({ src, alt }) => (
    <a href={src} target="_blank" rel="noopener noreferrer">
      {alt || src}
    </a>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export function MarkdownContent({ content, searchQuery }: MarkdownContentProps) {
  const rehypePlugins =
    searchQuery && searchQuery.length >= 3
      ? [rehypeHighlight(searchQuery)]
      : [];

  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={baseComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
