import type { ReactNode } from "react";
import { parseAgentMessage, parseAgentMessageInline, type AgentMessageBlock } from "@/lib/agent-message-markdown";

interface MessageBodyProps {
  body: string;
  className?: string;
}

function renderInline(text: string): ReactNode[] {
  return parseAgentMessageInline(text).map((token, index) => {
    if (token.type === "strong") return <strong key={index}>{token.text}</strong>;
    if (token.type === "code") return <code key={index}>{token.text}</code>;
    return <span key={index}>{token.text}</span>;
  });
}

function renderParagraph(text: string): ReactNode {
  return text.split("\n").map((line, index, lines) => (
    <span key={index}>
      {renderInline(line)}
      {index < lines.length - 1 && <br />}
    </span>
  ));
}

function renderBlock(block: AgentMessageBlock, index: number): ReactNode {
  switch (block.type) {
    case "heading": {
      const Heading = block.level === 2 ? "h2" : "h3";
      return <Heading key={index}>{renderInline(block.text)}</Heading>;
    }
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return <List key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</List>;
    }
    case "code":
      return <pre key={index} data-language={block.lang ?? undefined}><code>{block.text}</code></pre>;
    case "paragraph":
      return <p key={index}>{renderParagraph(block.text)}</p>;
  }
}

/** Shared safe renderer for ordinary and routed agent responses. */
export default function MessageBody({ body, className = "wf-chat-markdown-body" }: MessageBodyProps) {
  return <div className={className}>{parseAgentMessage(body).map(renderBlock)}</div>;
}
