"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

interface CodeEditorProps {
  content: string | object | undefined;
  filePath?: string | null;
  onChange?: (newContent: string) => void;
}

function getLanguageForFile(filePath?: string | null, content?: string | object): string {
  if (!filePath) {
    return typeof content === "object" ? "json" : "typescript";
  }

  const ext = filePath.split(".").pop()?.toLowerCase();

  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "html":
      return "html";
    case "yml":
    case "yaml":
      return "yaml";
    case "sh":
    case "bash":
      return "shell";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "toml":
      return "toml";
    default:
      return "plaintext";
  }
}

export function CodeEditor({ content, filePath, onChange }: CodeEditorProps) {
  const { resolvedTheme } = useTheme();

  const editorTheme = resolvedTheme === "light" ? "vs" : "vs-dark";
  const displayContent = useMemo(() => {
    if (content === undefined) return "";
    return typeof content === "object" ? JSON.stringify(content, null, 2) : content;
  }, [content]);
  const language = useMemo(() => getLanguageForFile(filePath, content), [filePath, content]);

  if (content === undefined) {
    return (
      <div className="flex-1 overflow-auto bg-background p-4 text-[11px] text-muted-foreground font-mono">
        <span>{"// Click Generate Bot to see files"}</span>
      </div>
    );
  }

  return (
    <div className="flex-1 h-full w-full">
      <MonacoEditor
        height="100%"
        width="100%"
        language={language}
        theme={editorTheme}
        value={displayContent}
        path={filePath ?? "inline"}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: "on",
          wordWrap: "on",
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          padding: { top: 12, bottom: 12 },
          renderWhitespace: "selection",
          tabSize: 2,
        }}
        onChange={(value) => {
          if (value !== undefined) {
            onChange?.(value);
          }
        }}
      />
    </div>
  );
}