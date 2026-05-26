import { Router } from "express";
import type { Request, Response } from "express";
import {
  listTodos,
  createTodo,
  updateTodo,
  deleteTodo,
} from "../db.js";
import type { CreateTodoBody, UpdateTodoBody } from "../types.js";

const router = Router();

// GET /api/todos
router.get("/", (_req: Request, res: Response) => {
  res.json(listTodos());
});

// POST /api/todos
router.post("/", (req: Request, res: Response) => {
  const body = req.body as CreateTodoBody;
  if (!body.text || typeof body.text !== "string" || body.text.trim() === "") {
    res.status(400).json({ error: "text is required and must be non-empty" });
    return;
  }
  const todo = createTodo(body);
  res.status(201).json(todo);
});

// PUT /api/todos/:id
// KNOWN BUG: returns 200 even when :id does not exist (should be 404).
// The db.updateTodo function constructs a phantom record instead of returning
// null, so this route never sees a "not found" signal.
router.put("/:id", (req: Request, res: Response) => {
  const body = req.body as UpdateTodoBody;
  const updated = updateTodo(req.params.id, body);
  // BUG: we always get a non-null value back, so we always return 200
  res.json(updated);
});

// DELETE /api/todos/:id
router.delete("/:id", (req: Request, res: Response) => {
  const deleted = deleteTodo(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "todo not found" });
    return;
  }
  res.status(204).send();
});

export default router;
