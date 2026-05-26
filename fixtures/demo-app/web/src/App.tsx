import { useEffect, useState } from "react";
import { fetchTodos, createTodo, updateTodo, deleteTodo } from "./api.js";
import type { Todo } from "./api.js";
import { AddTodo } from "./components/AddTodo.js";
import { TodoList } from "./components/TodoList.js";

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setTodos(await fetchTodos());
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleAdd(text: string) {
    const todo = await createTodo(text);
    setTodos((prev) => [...prev, todo]);
  }

  async function handleToggle(id: string, done: boolean) {
    const updated = await updateTodo(id, { done });
    setTodos((prev) => prev.map((t) => (t.id === id ? updated : t)));
  }

  async function handleDelete(id: string) {
    await deleteTodo(id);
    setTodos((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <main>
      <h1>TodoMVC</h1>
      {error && <p role="alert">Error: {error}</p>}
      <AddTodo onAdd={handleAdd} />
      <TodoList
        todos={todos}
        onToggle={handleToggle}
        onDelete={handleDelete}
      />
    </main>
  );
}
