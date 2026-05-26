import type { Todo } from "../api.js";

interface Props {
  todo: Todo;
  onToggle: (id: string, done: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function TodoItem({ todo, onToggle, onDelete }: Props) {
  return (
    <li>
      <input
        type="checkbox"
        checked={todo.done}
        onChange={(e) => onToggle(todo.id, e.target.checked)}
        aria-label={`Mark "${todo.text}" as ${todo.done ? "undone" : "done"}`}
      />
      <span style={{ textDecoration: todo.done ? "line-through" : "none" }}>
        {todo.text}
      </span>
      <button onClick={() => onDelete(todo.id)} aria-label={`Delete "${todo.text}"`}>
        Delete
      </button>
    </li>
  );
}
