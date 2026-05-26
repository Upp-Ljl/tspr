import { randomUUID } from "crypto";
import type { Todo, CreateTodoBody, UpdateTodoBody } from "./types.js";

// In-memory store; resets on each process boot (intentional — no persistence)
const todos: Map<string, Todo> = new Map();

export function listTodos(): Todo[] {
  return Array.from(todos.values()).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

export function createTodo(body: CreateTodoBody): Todo {
  const todo: Todo = {
    id: randomUUID(),
    text: body.text.trim(),
    done: false,
    createdAt: new Date().toISOString(),
  };
  todos.set(todo.id, todo);
  return todo;
}

/**
 * BUG (seeded for localsprite): returns the updated todo even when id does not
 * exist, instead of returning null. Callers cannot distinguish "updated" from
 * "phantom update on unknown id". The HTTP layer returns 200 in both cases.
 *
 * Correct behaviour would be: return null when id is not found, let the route
 * respond with 404.
 */
export function updateTodo(id: string, body: UpdateTodoBody): Todo {
  const existing = todos.get(id);
  // BUG: when existing is undefined we construct a phantom todo and return it
  // instead of returning null to signal "not found".
  const base: Todo = existing ?? {
    id,
    text: "",
    done: false,
    createdAt: new Date().toISOString(),
  };
  const updated: Todo = {
    ...base,
    ...(body.text !== undefined ? { text: body.text.trim() } : {}),
    ...(body.done !== undefined ? { done: body.done } : {}),
  };
  // Also write the phantom todo into the store (worsens the bug)
  todos.set(id, updated);
  return updated;
}

export function deleteTodo(id: string): boolean {
  return todos.delete(id);
}
