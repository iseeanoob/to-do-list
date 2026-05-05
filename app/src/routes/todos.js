const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimits");
const { normalizeDifficulty } = require("../helpers/todo");
const {
  MAX_COMPLETION_NOTES_LENGTH,
  MIN_ADMIN_ROLE_LEVEL,
  TODO_DEFAULT_COMPLETED,
  TODO_DEFAULT_COMPLETION_REQUESTED,
} = require("../config");

module.exports = function todosRouter(pool) {
  const router = express.Router();

  // ✅ Get todos
  router.get("/todos", userRateLimit, authenticateToken, async (req, res) => {
    try {
      const [rows] = await pool.query(
        "SELECT id, user_id, title, completed, completion_requested, completion_notes, difficulty, assigned_by_user_id, assigned_by_role, created_at FROM todos WHERE user_id = ? ORDER BY created_at DESC",
        [req.user.id]
      );
      res.json(rows);
    } catch {
      res.status(500).json({ error: "Error fetching todos." });
    }
  });

  // ➕ Add todo
  router.post("/todos", userRateLimit, authenticateToken, async (req, res) => {
    const { title } = req.body;
    const difficulty = normalizeDifficulty(req.body?.difficulty);
    if (!title) return res.status(400).json({ error: "Title required." });
    if (!difficulty) return res.status(400).json({ error: "Difficulty must be easy, medium, hard, or insane." });
    try {
      const [result] = await pool.query(
        "INSERT INTO todos (user_id, title, difficulty, assigned_by_user_id, assigned_by_role) VALUES (?, ?, ?, ?, ?)",
        [req.user.id, title, difficulty, req.user.id, req.user.role]
      );
      res.json({
        id: result.insertId,
        title,
        completed: TODO_DEFAULT_COMPLETED,
        completion_requested: TODO_DEFAULT_COMPLETION_REQUESTED,
        difficulty,
      });
    } catch {
      res.status(500).json({ error: "Error adding todo." });
    }
  });

  // ✏️ Update todo
  router.put("/todos/:id", userRateLimit, authenticateToken, async (req, res) => {
    const todoId = Number.parseInt(req.params.id, 10);
    const hasTitle = typeof req.body?.title === "string";
    const title = hasTitle ? req.body.title.trim() : "";
    const hasCompleted = typeof req.body?.completed === "boolean";
    const hasDifficulty = typeof req.body?.difficulty === "string";
    const difficulty = hasDifficulty ? normalizeDifficulty(req.body?.difficulty) : null;
    const hasCompletionNotes = typeof req.body?.completionNotes === "string";
    const completionNotes = hasCompletionNotes ? String(req.body.completionNotes || "").trim() : "";

    if (!Number.isInteger(todoId) || todoId <= 0) {
      return res.status(400).json({ error: "Invalid todo id." });
    }
    if (!hasTitle && !hasCompleted && !hasDifficulty && !hasCompletionNotes) {
      return res.status(400).json({ error: "Provide title, completed status, difficulty, and/or completion notes." });
    }
    if (hasTitle && !title) {
      return res.status(400).json({ error: "Title cannot be empty." });
    }
    if (hasDifficulty && !difficulty) {
      return res.status(400).json({ error: "Difficulty must be easy, medium, hard, or insane." });
    }
    if (hasCompletionNotes && completionNotes.length > MAX_COMPLETION_NOTES_LENGTH) {
      return res.status(400).json({ error: `Completion notes must be ${MAX_COMPLETION_NOTES_LENGTH} characters or less.` });
    }
    if (hasCompletionNotes && (!hasCompleted || req.body.completed !== true)) {
      return res.status(400).json({ error: "Completion notes can only be set while requesting completion." });
    }

    try {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        const [todoRows] = await conn.query(
          `SELECT
             id,
             completed,
             completion_requested,
             completion_notes,
             difficulty,
             xp_awarded,
             assigned_by_user_id,
             assigned_by_role
           FROM todos
           WHERE id = ? AND user_id = ?
           LIMIT 1
           FOR UPDATE`,
          [todoId, req.user.id]
        );
        if (todoRows.length === 0) {
          await conn.rollback();
          return res.status(404).json({ error: "Todo not found." });
        }
        const todo = todoRows[0];

        const setClauses = [];
        const params = [];
        if (hasTitle) {
          setClauses.push("title = ?");
          params.push(title);
        }
        if (hasCompleted) {
          if (req.body.completed === true) {
            if (!Boolean(todo.completed)) {
              setClauses.push("completion_requested = TRUE");
              if (hasCompletionNotes) {
                setClauses.push("completion_notes = ?");
                params.push(completionNotes || null);
              }
            }
          } else {
            setClauses.push("completed = FALSE");
            setClauses.push("completion_requested = FALSE");
            setClauses.push("completion_notes = NULL");
            setClauses.push("completion_reviewed_by_user_id = NULL");
            setClauses.push("completion_reviewed_at = NULL");
          }
        }
        if (hasDifficulty) {
          const assignedByAdmin = Number(todo.assigned_by_role) >= MIN_ADMIN_ROLE_LEVEL;
          const isSelfAssigned = Number(todo.assigned_by_user_id) === Number(req.user.id) && !assignedByAdmin;
          if (!isSelfAssigned) {
            await conn.rollback();
            return res.status(403).json({ error: "You can only change difficulty for self-assigned todos." });
          }
          if (Boolean(todo.completed) || Boolean(todo.completion_requested)) {
            await conn.rollback();
            return res.status(400).json({ error: "Cannot change difficulty after completion is requested or approved." });
          }
          setClauses.push("difficulty = ?");
          params.push(difficulty);
        }

        if (setClauses.length === 0) {
          await conn.commit();
          return res.json({ message: "Todo unchanged.", xpGained: 0 });
        }

        params.push(todoId, req.user.id);
        const [result] = await conn.query(
          `UPDATE todos SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`,
          params
        );
        if (result.affectedRows === 0) {
          await conn.rollback();
          return res.status(404).json({ error: "Todo not found." });
        }

        await conn.commit();
        return res.json({ message: "Todo updated.", xpGained: 0 });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error updating todo." });
    }
  });

  // 🗑️ Delete todo
  router.delete("/todos/:id", userRateLimit, authenticateToken, async (req, res) => {
    const todoId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(todoId) || todoId <= 0) {
      return res.status(400).json({ error: "Invalid todo id." });
    }

    try {
      const [result] = await pool.query("DELETE FROM todos WHERE id = ? AND user_id = ?", [
        todoId,
        req.user.id,
      ]);
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Todo not found." });
      }
      res.json({ message: "Todo deleted." });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error deleting todo." });
    }
  });

  // 📋 Get my todo requests
  router.get("/todo-requests", userRateLimit, authenticateToken, async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT
           id,
           requested_by_user_id,
           title,
           difficulty,
           status,
           distributed_to_user_id,
           distributed_todo_id,
           handled_by_user_id,
           handled_at,
           created_at
         FROM todo_requests
         WHERE requested_by_user_id = ?
         ORDER BY created_at DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error fetching todo requests." });
    }
  });

  // 📤 Submit a todo request
  router.post("/todo-requests", userRateLimit, authenticateToken, async (req, res) => {
    const title = String(req.body?.title || "").trim();
    const difficulty = normalizeDifficulty(req.body?.difficulty);
    if (!title) return res.status(400).json({ error: "Title required." });
    if (!difficulty) return res.status(400).json({ error: "Difficulty must be easy, medium, hard, or insane." });

    try {
      const [result] = await pool.query(
        "INSERT INTO todo_requests (requested_by_user_id, title, difficulty) VALUES (?, ?, ?)",
        [req.user.id, title, difficulty]
      );
      res.json({
        message: "Todo request sent to admins.",
        request: {
          id: result.insertId,
          requested_by_user_id: req.user.id,
          title,
          difficulty,
          status: "pending",
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error creating todo request." });
    }
  });

  return router;
};
