# demo-app — TodoMVC fixture for localsprite

Minimal Express + React TodoMVC. Used by `scripts/smoke-localsprite.mjs` to
give localsprite a real running app to test against.

## Boot

```bash
# Backend (port 5174)
cd server && npm install && npm run dev

# Frontend (port 5173) — in a separate shell
cd web && npm install && npm run dev
```

Or both at once from the workspace root:

```bash
npm install   # installs concurrently + workspaces
npm run dev
```

## Endpoints

| Method | Path            | Description              |
|--------|-----------------|--------------------------|
| GET    | /api/todos      | List all todos           |
| POST   | /api/todos      | Create todo `{text}`     |
| PUT    | /api/todos/:id  | Update todo `{text?,done?}` |
| DELETE | /api/todos/:id  | Delete todo              |
| GET    | /health         | Liveness probe           |

## Known bugs (for localsprite to find)

**BUG-001 — PUT /api/todos/:id returns 200 for non-existent ids**

`PUT /api/todos/<random-uuid>` with a valid JSON body returns HTTP **200** and
a synthesised todo object instead of **404 Not Found**.

Root cause: `db.ts::updateTodo()` constructs a phantom `Todo` record when the
id is missing from the store, then writes it back. The route handler never
receives `null` and therefore never sends a 404 response.

Correct behaviour: return 404 when the id is not found in the store.

Reproduce:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -X PUT http://localhost:5174/api/todos/00000000-0000-0000-0000-000000000000 \
  -H "Content-Type: application/json" \
  -d '{"done": true}'
# Expected: 404   Actual: 200
```
