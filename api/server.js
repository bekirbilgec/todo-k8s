const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const pino = require("pino");
const pinoHttp = require("pino-http");
const swaggerUi = require("swagger-ui-express");
const { z } = require("zod");
const crypto = require("crypto");
const { Pool } = require("pg");

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

// Validation
const TodoCreateSchema = z.object({
  text: z.string().trim().min(1).max(200),
});

const TodoPutSchema = z.object({
  text: z.string().trim().min(1).max(200),
  done: z.boolean(),
});

const TodoPatchSchema = z
  .object({
    text: z.string().trim().min(1).max(200).optional(),
    done: z.boolean().optional(),
  })
  .refine((v) => v.text !== undefined || v.done !== undefined, {
    message: "At least one field required",
  });

const BulkCreateSchema = z.object({
  items: z.array(TodoCreateSchema).min(1).max(100),
});

// PostgreSQL
if (!process.env.DATABASE_URL) {
  logger.warn("DATABASE_URL is not set. API will fail until it is provided.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.PGSSLMODE === "require"
      ? { rejectUnauthorized: false }
      : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id BIGSERIAL PRIMARY KEY,
      text VARCHAR(200) NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_todos_updated_at ON todos(updated_at);`
  );
}

function mapTodo(row) {
  return {
    id: Number(row.id),
    text: row.text,
    done: row.done,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Health endpoints
app.get("/healthz", (_, res) => res.status(200).send("ok"));
app.get("/readyz", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).send("ready");
  } catch (e) {
    res.status(503).send("not-ready");
  }
});

// OpenAPI
const openapi = {
  openapi: "3.0.3",
  info: { title: "Todo API", version: "1.2.0" },
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
app.get("/v1/todos", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim().toLowerCase();

    const doneRaw = req.query.done?.toString();
    let doneFilter = null;
    if (doneRaw !== undefined) {
      const b = parseBool(doneRaw);
      if (b === null) return apiError(res, 400, "VALIDATION_ERROR", "done must be true or false");
      doneFilter = b;
    }

    const sort = (req.query.sort || "createdAt").toString();
    const order = (req.query.order || "desc").toString().toLowerCase() === "asc" ? "asc" : "desc";
    const sortCol = sort === "updatedAt" ? "updated_at" : sort === "createdAt" ? "created_at" : "id";

    const limit = Math.min(Number(req.query.limit || 20), 100);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    const where = [];
    const params = [];
    let i = 1;

    if (q) {
      where.push(`LOWER(text) LIKE $${i++}`);
      params.push(`%${q}%`);
    }
    if (doneFilter !== null) {
      where.push(`done = $${i++}`);
      params.push(doneFilter);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const totalR = await pool.query(`SELECT COUNT(*)::bigint AS c FROM todos ${whereSql}`, params);
    const total = Number(totalR.rows[0].c);

    const listR = await pool.query(
      `SELECT * FROM todos ${whereSql} ORDER BY ${sortCol} ${order} LIMIT $${i++} OFFSET $${i++}`,
      [...params, limit, offset]
    );

    const items = listR.rows.map(mapTodo);

    res.json({
      items,
      meta: {
        total,
        limit,
        offset,
        hasNext: offset + limit < total,
        hasPrev: offset > 0,
      },
    });
  } catch (err) {
    req.log.error({ err }, "List todos failed");
    apiError(res, 500, "INTERNAL_ERROR", "Internal server error");
  }
});

app.get("/v1/todos/stats", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*)::bigint AS total,
        SUM(CASE WHEN done THEN 1 ELSE 0 END)::bigint AS done
      FROM todos
    `);
    const total = Number(r.rows[0].total);
    const done = Number(r.rows[0].done || 0);
    res.json({ total, done, pending: total - done });
  } catch (err) {
    req.log.error({ err }, "Stats failed");
    apiError(res, 500, "INTERNAL_ERROR", "Internal server error");
  }
});

app.get("/v1/todos/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query(`SELECT * FROM todos WHERE id = $1`, [id]);
    if (!r.rows[0]) return apiError(res, 404, "NOT_FOUND", "Todo not found");
    res.json(mapTodo(r.rows[0]));
  } catch (err) {
    req.log.error({ err }, "Get todo failed");
    apiError(res, 500, "INTERNAL_ERROR", "Internal server error");
  }
});

app.post("/v1/todos", async (req, res) => {
  const parsed = TodoCreateSchema.safeParse(req.body);
  if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", "Invalid body", parsed.error.flatten());

  try {
    const r = await pool.query(
      `INSERT INTO todos(text, done) VALUES ($1, false) RETURNING *`,
      [parsed.data.text]
    );
    res.status(201).json(mapTodo(r.rows[0]));
  } catch (err) {
    req.log.error({ err }, "Create todo failed");
    apiError(res, 500, "INTERNAL_ERROR", "Internal server error");
  }
});

app.post("/v1/todos/bulk", async (req, res) => {
  const parsed = BulkCreateSchema.safeParse(req.body);
  if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", "Invalid body", parsed.error.flatten());

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = [];
    for (const it of parsed.data.items) {
      const r = await client.query(
        `INSERT INTO todos(text, done) VALUES ($1, false) RETURNING *`,
        [it.text]
      );
      created.push(mapTodo(r.rows[0]));
    }
    await client.query("COMMIT");
    res.status(201).json({ items: created });
  } catch (err) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "Bulk create failed");
    apiError(res, 500, "INTERNAL_ERROR", "Internal server error");
  } finally {
    client.release();
  }
});

app.put("/v1/todos/:id", async (req, res) => {
  const parsed = TodoPutSchema.safeParse(req.body);
  if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", "Invalid body", parsed.error.flatten());

  try {
    const id = Number(req.params.id);
    const r = await pool.query(
      `UPDATE todos
       SET text = $1, done = $2, updated_at = now()
       WHERE id = $3
       RETURNING *`,
      [parsed.data.text, parsed.data.done, id]
    );
    if (!r.rows[0]) return apiError(res, 404, "NOT_FOUND", "Todo not found");
    res.json(mapTodo(r.rows[0]));
  } catch (err) {
    req.log.error({ err }, "Put todo failed");
    apiError(res, 500, "INTERNAL_ERROR", "Internal server error");
  }
});

app.patch("/v1/todos/:id", async (req, res) => {
  const parsed = TodoPatchSchema.safeParse(req.body);
  if (!parsed.success) return apiError(res, 400, "VALIDATION_ERROR", "Invalid body", parsed.error.flatten());

  try {
    const id = Number(req.params.id);
    const r = await pool.query(`SELECT * FROM todos WHERE id = $1`, [id]);
    if (!r.rows[0]) return apiError(res, 404, "NOT_FOUND", "Todo not found");

    const current = r.rows[0];
    const newText = parsed.data.text !== undefined ? parsed.data.text : current.text;
    const newDone = parsed.data.done !== undefined ? parsed.data.done : current.done;

    const u = await pool.query(
      `UPDATE todos SET text = $1, done = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [newText, newDone, id]
    );

    res.json(mapTodo(u.rows[0]));
  } catch (err) {
    req.log.error({ err }, "Patch todo failed");
    apiError(res, 500, "INTERNAL_ERROR", "Internal server error");
  }
});

app.delete("/v1/todos/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query(`DELETE FROM todos WHERE id = $1`, [id]);
    if (r.rowCount === 0) return apiError(res, 404, "NOT_FOUND", "Todo not found");
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Delete todo failed");
    apiError(res, 500, "INTERNAL_ERROR", "Internal server error");
  }
});

// 404
app.use((req, res) => apiError(res, 404, "NOT_FOUND", "Route not found"));

// Error handler
app.use((err, req, res, next) => {
  req.log.error({ err }, "Unhandled error");
  apiError(res, 500, "INTERNAL_ERROR", "Internal server error");
});

async function shutdown(signal) {
  try {
    logger.info({ signal }, "Shutting down");
    await pool.end();
  } catch (e) {
    logger.error({ err: e }, "Error during shutdown");
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const port = Number(process.env.PORT || 3000);

initDb()
  .then(() => {
    app.listen(port, "0.0.0.0", () => {
      logger.info({ port }, "todo-api started");
    });
  })
  .catch((err) => {
    logger.error({ err }, "DB init failed");
    process.exit(1);
  });
