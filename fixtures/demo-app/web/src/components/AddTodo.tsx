import { useState } from "react";

interface Props {
  onAdd: (text: string) => Promise<void>;
}

export function AddTodo({ onAdd }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await onAdd(trimmed);
      setText("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What needs to be done?"
        disabled={busy}
        aria-label="New todo text"
      />
      <button type="submit" disabled={busy || text.trim() === ""}>
        Add
      </button>
    </form>
  );
}
