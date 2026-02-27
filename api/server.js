const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const pino = require("pino");
const pinoHttp = require("pino-http");
const swaggerUi = require("swagger-ui-express");
const { z } = require("zod");
const crypto = require("crypto");

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "256kb" }));

// Request ID + structured logs
app.use((req, res, next) => {
  req.id = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
});
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => req.id,
    customLogLevel: (res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  })
);

// CORS (lokalde web 8080)
app.use(
  cors({
    origin: ["http://localhost:8080"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "X-Request-Id"],
  })
);

// In-memory store
let todos = [
  {
    id: 1,
    text: "İlk todo",
    done: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];
let nextId = 2;

// Helpers
function apiError(res, status, code, message, details) {
  return res.status(status).json({
    error: { code, message, details: details || null },
    requestId: res.getHeader("x-request-id"),
  });
}

function parseBool(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function sortTodos(items, sort, order) {
  const dir = order === "desc" ? -1 : 1;
  const key = sort === "updatedAt" ? "updatedAt" : sort === "createdAt" ? "createdAt" : "id";
  return items.slice().sort((a, b) => (a[key] > b[key] ? 1 * dir : a[key] < b[key] ? -1 * dir : 0));
}

// Validation
const TodoCreateSchema = z.object({
  text: z.string().trim().min(1).max(200),
});

const TodoPutSchema = z.object({
  text: z.string().trim().min(1).max(200),
  done: z.boolean(),
});

const TodoPatchSchema = z.object({
  text: z.string().trim().min(1).max(200).optional(),
  done: z.boolean().optional(),
}).refine((v) => v.text !== undefined || v.done !== undefined, {
  message: "At least one field required",
});

const BulkCreateSchema = z.object({
  items: z.array(TodoCreateSchema).min(1).max(100),
});

// Health endpoints
app.get("/healthz", (_, res) => res.status(200).send("ok"));
app.get("/readyz", (_, res) => res.status(200).send("ready"));

// OpenAPI
const openapi = {
  openapi: "3.0.3",
  info: { title: "Todo API", version: "1.1.0" },
  servers: [{ url: "/" }],
  paths: {
    "/v1/todos": {
      get: {
        summary: "List todos",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "done", in: "query", schema: { type: "boolean" } },
          { name: "sort", in: "query", schema: { type: "string", enum: ["id", "createdAt", "updatedAt"] } },
          { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"] } }
        ],
        responses: { 200: { description: "OK" } }
      },
      post: { summary: "Create todo", responses: { 201: { description: "Created" } } }
    },
    "/v1/todos/{id}": {
      get: { summary: "Get todo", responses: { 200: { description: "OK" }, 404: { description: "Not found" } } },
      put: { summary: "Replace todo", responses: { 200: { description: "OK" } } },
      patch: { summary: "Update todo", responses: { 200: { description: "OK" } } },
      delete: { summary: "Delete todo", responses: { 204: { description: "No Content" } } }
    },
    "/v1/todos/bulk": {
      post: { summary: "Bulk create", responses: { 201: { description: "Created" } } }
    },
    "/v1/todos/stats": {
      get: { summary: "Stats", responses: { 200: { description: "OK" } } }
    }
  }
};

app.get("/v1/openapi.json", (_, res) => res.json(openapi));
app.use("/v1/docs", swaggerUi.serve, swaggerUi.setup(openapi));

// Routes
app.get("/v1/todos", (req, res) => {
  let items = todos;

  const q = (req.query.q || "").toString().trim().toLowerCase();
  if (q) items = items.filter((t) => t.text.toLowerCase().includes(q));

  const doneRaw = req.query.done?.toString();
  if (doneRaw !== undefined) {
    const b = parseBool(doneRaw);
    if (b === null) return apiError(res, 400, "VALIDATION_ERROR", "done must be true or false");
    items = items.filter((t) => t.done === b);
  }

  const sort = (req.query.sort || "createdAt").toString();
  const order = (req.query.order || "desc").toString();
  items = sortTodos(items, sort, order);

  const limit = Math.min(Number(req.query.limit || 20), 100);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  const page = items.slice(offset, offset + limit);

  res.json({
    items: page,
    meta: {
      total: items.length,
      limit,
      offset,
      hasNext: offset + limit < items.length,
      hasPrev: offset > 0,
    },
  });
});

app.get("/v1/todos/stats", (_, res) => {
  const total = todos.length;
  const done = todos.filter((t) => t.done).length;
  res.json({ total, done, pending: total - done });
});

app.get("/v1/todos/:id", (req, res) => {
  const id = Number(req.params.id);
  const t = todos.find((x) => x.id === id);
  if (!t) return apiError(res, 404, "NOT_FOUND", "Todo not found");
  res.json(t);
});

app.post("/v1/todos", (req, res) => {
  const parsed = TodoCreateSchema.safeParse(req.body);
  if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", "Invalid body", parsed.error.flatten());

  const now = new Date().toISOString();
  const todo = { id: nextId++, text: parsed.data.text, done: false, createdAt: now, updatedAt: now };
  todos.push(todo);

  res.status(201).json(todo);
});

app.post("/v1/todos/bulk", (req, res) => {
  const parsed = BulkCreateSchema.safeParse(req.body);
  if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", "Invalid body", parsed.error.flatten());

  const now = new Date().toISOString();
  const created = parsed.data.items.map((it) => {
    const todo = { id: nextId++, text: it.text, done: false, createdAt: now, updatedAt: now };
    todos.push(todo);
    return todo;
  });

  res.status(201).json({ items: created });
});

app.put("/v1/todos/:id", (req, res) => {
  const id = Number(req.params.id);
  const idx = todos.findIndex((x) => x.id === id);
  if (idx === -1) return apiError(res, 404, "NOT_FOUND", "Todo not found");

  const parsed = TodoPutSchema.safeParse(req.body);
  if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", "Invalid body", parsed.error.flatten());

  const now = new Date().toISOString();
  todos[idx] = {
    ...todos[idx],
    text: parsed.data.text,
    done: parsed.data.done,
    updatedAt: now,
  };

  res.json(todos[idx]);
});

app.patch("/v1/todos/:id", (req, res) => {
  const id = Number(req.params.id);
  const t = todos.find((x) => x.id === id);
  if (!t) return apiError(res, 404, "NOT_FOUND", "Todo not found");

  const parsed = TodoPatchSchema.safeParse(req.body);
  if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", "Invalid body", parsed.error.flatten());

  const now = new Date().toISOString();
  if (parsed.data.text !== undefined) t.text = parsed.data.text;
  if (parsed.data.done !== undefined) t.done = parsed.data.done;
  t.updatedAt = now;

  res.json(t);
});

app.delete("/v1/todos/:id", (req, res) => {
  const id = Number(req.params.id);
  const before = todos.length;
  todos = todos.filter((x) => x.id !== id);
  if (todos.length === before) return apiError(res, 404, "NOT_FOUND", "Todo not found");
  res.status(204).send();
});

// 404
app.use((req, res) => apiError(res, 404, "NOT_FOUND", "Route not found"));

// Error handler
app.use((err, req, res, next) => {
  req.log.error({ err }, "Unhandled error");
  apiError(res, 500, "INTERNAL_ERROR", "Internal server error");
});

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "todo-api started");
});