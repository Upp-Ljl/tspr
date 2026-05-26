export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

const BASE = "/api/todos";

export async function fetchTodos(): Promise<Todo[]> {
  const res = await fetch(BASE);
  if (!res.ok) throw new Error(`GET /api/todos failed: ${res.status}`);
  return res.json() as Promise<Todo[]>;
}

export async function createTodo(text: string): Promise<Todo> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`POST /api/todos failed: ${res.status}`);
  return res.json() as Promise<Todo>;
}

export async function updateTodo(
  id: string,
  patch: Partial<Pick<Todo, "text" | "done">>
): Promise<Todo> {
  const res = await fetch(`${BASE}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`PUT /api/todos/${id} failed: ${res.status}`);
  return res.json() as Promise<Todo>;
}

export async function deleteTodo(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE /api/todos/${id} failed: ${res.status}`);
}
