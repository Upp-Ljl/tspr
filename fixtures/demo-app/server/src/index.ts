import express from "express";
import cors from "cors";
import todosRouter from "./routes/todos.js";

const app = express();
const PORT = Number(process.env.PORT ?? 5174);

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/todos", todosRouter);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`demo-app server listening on http://localhost:${PORT}`);
});

export default app;
