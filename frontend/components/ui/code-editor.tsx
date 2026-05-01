// frontend/components/ui/CodeEditor.tsx
interface CodeEditorProps {
  content: string | object | undefined;
  onChange?: (newContent: string) => void;
}

export function CodeEditor({ content, onChange }: CodeEditorProps) {
  if (content === undefined) {
    return (
      <div className="flex-1 overflow-auto bg-background p-4 text-[11px] text-muted-foreground font-mono">
        <span>{"// Click Generate Bot to see files"}</span>
      </div>
    );
  }

  const displayContent = typeof content === "object" ? JSON.stringify(content, null, 2) : content;

  return (
    <textarea
      value={displayContent}
      onChange={(e) => onChange?.(e.target.value)}
      spellCheck={false}
      className="flex-1 w-full h-full resize-none outline-none bg-background p-4 text-[11px] leading-relaxed text-foreground/90 whitespace-pre font-mono focus:ring-0 border-none"
    />
  );
}