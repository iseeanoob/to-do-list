const express = require("express");
const { requireRank } = require("../middleware/auth");
const { adminRateLimit } = require("../middleware/rateLimits");
const { normalizeDifficulty, normalizeTeamSize, canAssignTodo } = require("../helpers/todo");
const { getRequiredXpForLevel, applyXpProgression } = require("../helpers/xp");
const {
  ROLES,
  MIN_ADMIN_ROLE_LEVEL,
  TODO_DIFFICULTY_XP,
  TODO_DEFAULT_COMPLETED,
  TODO_DEFAULT_COMPLETION_REQUESTED,
} = require("../config");

module.exports = function adminRouter(pool) {
  const router = express.Router();

  // 🧑‍💼 All users + their todos
  router.get("/admin/users-todos", adminRateLimit, requireRank(4), async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT
          u.id AS user_id,
          u.username,
          u.email,
          u.role,
          t.id AS todo_id,
          t.title AS todo_title,
          t.completed AS todo_completed,
          t.completion_requested AS todo_completion_requested,
          t.difficulty AS todo_difficulty,
          t.assigned_by_role AS assigned_by_role,
          t.created_at AS todo_created_at
        FROM users u
        LEFT JOIN todos t ON t.user_id = u.id
        ORDER BY u.id ASC, t.created_at DESC`
      );

      const userMap = new Map();
      for (const row of rows) {
        if (!userMap.has(row.user_id)) {
          userMap.set(row.user_id, {
            id: row.user_id,
            username: row.username,
            email: row.email,
            role: row.role,
            roleName: ROLES[row.role],
            totalTodos: 0,
            completed: 0,
            pendingApproval: 0,
            todos: [],
          });
        }

        if (row.todo_id) {
          const user = userMap.get(row.user_id);
          const todo = {
            id: row.todo_id,
            user_id: row.user_id,
            title: row.todo_title,
            completed: !!row.todo_completed,
            completion_requested: !!row.todo_completion_requested,
            difficulty: row.todo_difficulty || "easy",
            assigned_by_role: row.assigned_by_role,
            created_at: row.todo_created_at,
          };
          user.todos.push(todo);
          user.totalTodos += 1;
          if (todo.completed) user.completed += 1;
          if (todo.completion_requested) user.pendingApproval += 1;
        }
      }

      res.json(Array.from(userMap.values()));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error fetching admin data." });
    }
  });

  // 📝 Assign todo to a user
  router.post("/admin/users/:id/todos", adminRateLimit, requireRank(4), async (req, res) => {
    const { id } = req.params;
    const title = (req.body?.title || "").trim();
    const difficulty = normalizeDifficulty(req.body?.difficulty);
    if (!title) return res.status(400).json({ error: "Title required." });
    if (!difficulty) return res.status(400).json({ error: "Difficulty must be easy, medium, hard, or insane." });

    try {
      const [rows] = await pool.query("SELECT id, role FROM users WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "User not found." });

      const target = rows[0];
      if (!canAssignTodo(req.user.role, target.role)) {
        return res.status(403).json({ error: "Not allowed to assign todo to this role." });
      }

      const [result] = await pool.query(
        "INSERT INTO todos (user_id, title, difficulty, assigned_by_user_id, assigned_by_role) VALUES (?, ?, ?, ?, ?)",
        [target.id, title, difficulty, req.user.id, req.user.role]
      );

      res.json({
        message: "Todo assigned successfully.",
        todo: {
          id: result.insertId,
          user_id: target.id,
          title,
          completed: TODO_DEFAULT_COMPLETED,
          completion_requested: TODO_DEFAULT_COMPLETION_REQUESTED,
          difficulty,
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error assigning todo." });
    }
  });

  // 📋 All todo requests
  router.get("/admin/todo-requests", adminRateLimit, requireRank(4), async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT
           tr.id,
           tr.requested_by_user_id,
           requester.username AS requested_by_username,
           requester.role AS requested_by_role,
           tr.title,
           tr.difficulty,
           tr.status,
           tr.distributed_to_user_id,
           tr.distributed_todo_id,
           tr.handled_by_user_id,
           tr.handled_at,
           tr.created_at
         FROM todo_requests tr
         INNER JOIN users requester ON requester.id = tr.requested_by_user_id
         ORDER BY tr.created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error fetching todo requests." });
    }
  });

  // ⏳ Pending completion approvals
  router.get("/admin/pending-approvals", adminRateLimit, requireRank(4), async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT
           t.id,
           t.user_id,
           t.title,
           t.difficulty,
           t.completion_notes,
           t.created_at,
           u.username,
           u.role AS user_role
         FROM todos t
         INNER JOIN users u ON u.id = t.user_id
         WHERE t.completion_requested = TRUE
           AND t.completed = FALSE
         ORDER BY t.created_at DESC`
      );
      const visible = rows.filter((row) => canAssignTodo(req.user.role, row.user_role));
      res.json(visible);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error fetching pending approvals." });
    }
  });

  // 📦 Distribute a todo request
  router.post("/admin/todo-requests/:id/distribute", adminRateLimit, requireRank(4), async (req, res) => {
    const requestId = Number.parseInt(req.params.id, 10);
    const targetUserId = Number.parseInt(req.body?.targetUserId, 10);
    const overrideTitle = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const difficulty = normalizeDifficulty(req.body?.difficulty);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: "Invalid request id." });
    }
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "Invalid target user id." });
    }
    if (!difficulty) return res.status(400).json({ error: "Difficulty must be easy, medium, hard, or insane." });

    try {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        const [requestRows] = await conn.query(
          `SELECT id, title, status
           FROM todo_requests
           WHERE id = ?
           LIMIT 1
           FOR UPDATE`,
          [requestId]
        );
        if (requestRows.length === 0) {
          await conn.rollback();
          return res.status(404).json({ error: "Todo request not found." });
        }
        const todoRequest = requestRows[0];
        if (todoRequest.status !== "pending") {
          await conn.rollback();
          return res.status(400).json({ error: "Todo request has already been handled." });
        }

        const [targetRows] = await conn.query(
          "SELECT id, role FROM users WHERE id = ? LIMIT 1",
          [targetUserId]
        );
        if (targetRows.length === 0) {
          await conn.rollback();
          return res.status(404).json({ error: "Target user not found." });
        }
        const target = targetRows[0];
        if (!canAssignTodo(req.user.role, target.role)) {
          await conn.rollback();
          return res.status(403).json({ error: "Not allowed to distribute to this role." });
        }

        const todoTitle = overrideTitle || todoRequest.title;
        if (!todoTitle) {
          await conn.rollback();
          return res.status(400).json({ error: "Title required." });
        }

        const [todoResult] = await conn.query(
          "INSERT INTO todos (user_id, title, difficulty, assigned_by_user_id, assigned_by_role) VALUES (?, ?, ?, ?, ?)",
          [target.id, todoTitle, difficulty, req.user.id, req.user.role]
        );
        await conn.query(
          `UPDATE todo_requests
           SET status = 'distributed',
               distributed_to_user_id = ?,
               distributed_todo_id = ?,
               handled_by_user_id = ?,
               handled_at = NOW()
           WHERE id = ?`,
          [target.id, todoResult.insertId, req.user.id, requestId]
        );

        await conn.commit();
        return res.json({
          message: "Todo request distributed successfully.",
          todo: {
            id: todoResult.insertId,
            user_id: target.id,
            title: todoTitle,
            difficulty,
          },
        });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error distributing todo request." });
    }
  });

  // ✅ Approve pending todo completion
  router.put("/admin/todos/:id/approve", adminRateLimit, requireRank(4), async (req, res) => {
    const todoId = Number.parseInt(req.params.id, 10);
    const hasDifficulty = typeof req.body?.difficulty === "string";
    const difficulty = hasDifficulty ? normalizeDifficulty(req.body?.difficulty) : null;
    if (!Number.isInteger(todoId) || todoId <= 0) {
      return res.status(400).json({ error: "Invalid todo id." });
    }
    if (hasDifficulty && !difficulty) {
      return res.status(400).json({ error: "Difficulty must be easy, medium, hard, or insane." });
    }

    try {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        const [todoRows] = await conn.query(
          `SELECT
             t.id,
             t.user_id,
             t.completed,
             t.completion_requested,
             t.completion_notes,
             t.difficulty,
             t.xp_awarded,
             u.role AS user_role,
             u.xp AS user_xp,
             u.level AS user_level
           FROM todos t
           INNER JOIN users u ON u.id = t.user_id
           WHERE t.id = ?
           LIMIT 1
           FOR UPDATE`,
          [todoId]
        );
        if (todoRows.length === 0) {
          await conn.rollback();
          return res.status(404).json({ error: "Todo not found." });
        }

        const todo = todoRows[0];
        if (!canAssignTodo(req.user.role, todo.user_role)) {
          await conn.rollback();
          return res.status(403).json({ error: "Not allowed to approve this user's todo." });
        }
        if (Boolean(todo.completed)) {
          await conn.rollback();
          return res.json({ message: "Todo is already approved as completed.", xpGained: 0 });
        }
        if (!Boolean(todo.completion_requested)) {
          await conn.rollback();
          return res.status(400).json({ error: "Todo completion has not been requested yet." });
        }

        const shouldAwardXp = !Boolean(todo.xp_awarded);
        const effectiveDifficulty = difficulty || todo.difficulty;
        await conn.query(
          `UPDATE todos
           SET completed = TRUE,
               completion_requested = FALSE,
               difficulty = ?,
               completion_reviewed_by_user_id = ?,
               completion_reviewed_at = NOW(),
               xp_awarded = CASE WHEN xp_awarded = TRUE THEN TRUE ELSE ? END
           WHERE id = ?`,
          [effectiveDifficulty, req.user.id, shouldAwardXp, todoId]
        );

        let progression = null;
        let xpGained = 0;
        if (shouldAwardXp) {
          xpGained = TODO_DIFFICULTY_XP[effectiveDifficulty];
          progression = applyXpProgression(todo.user_xp, todo.user_level, xpGained);
          await conn.query("UPDATE users SET xp = ?, level = ? WHERE id = ?", [
            progression.xp,
            progression.level,
            todo.user_id,
          ]);
        }

        await conn.commit();
        return res.json({
          message: "Todo completion approved.",
          difficulty: effectiveDifficulty,
          xpGained,
          xp: progression ? progression.xp : undefined,
          level: progression ? progression.level : undefined,
          nextLevelXp: progression ? getRequiredXpForLevel(progression.level) : undefined,
        });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error approving todo completion." });
    }
  });

  // 🔺 Promote/Demote user role
  router.put("/admin/role/:id", adminRateLimit, requireRank(4), async (req, res) => {
    const { id } = req.params;
    const { newRole } = req.body;

    if (!newRole || newRole < 1 || newRole > 5)
      return res.status(400).json({ error: "Invalid role value (1-5)." });

    try {
      const [rows] = await pool.query("SELECT role FROM users WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "User not found." });

      // Allow promotion/demotion only up to one rank below your own role
      if (newRole >= req.user.role && req.user.role < 5)
        return res.status(403).json({ error: "Cannot promote to equal or higher than your own rank." });

      await pool.query("UPDATE users SET role = ? WHERE id = ?", [newRole, id]);
      res.json({ message: `User role updated to ${ROLES[newRole]}.` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error updating user role." });
    }
  });

  // ❌ Delete user
  router.delete("/admin/users/:id", adminRateLimit, requireRank(4), async (req, res) => {
    const { id } = req.params;
    try {
      const [rows] = await pool.query("SELECT role FROM users WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "User not found." });

      if (rows[0].role >= req.user.role && req.user.role < 5)
        return res.status(403).json({ error: "Cannot delete equal or higher rank." });

      await pool.query("DELETE FROM users WHERE id = ?", [id]);
      res.json({ message: "User deleted successfully." });
    } catch {
      res.status(500).json({ error: "Error deleting user." });
    }
  });

  // 🏗️ Create team todo
  router.post("/admin/team-todos", adminRateLimit, requireRank(4), async (req, res) => {
    const title = String(req.body?.title || "").trim();
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
    const difficulty = normalizeDifficulty(req.body?.difficulty);
    const maxTeamSize = normalizeTeamSize(req.body?.maxTeamSize);
    if (!title) return res.status(400).json({ error: "Title required." });
    if (!difficulty) return res.status(400).json({ error: "Difficulty must be easy, medium, hard, or insane." });
    if (!maxTeamSize) return res.status(400).json({ error: "Max team size must be between 1 and 20." });

    try {
      const [result] = await pool.query(
        "INSERT INTO team_todos (title, description, difficulty, max_team_size, created_by_user_id, created_by_role) VALUES (?, ?, ?, ?, ?, ?)",
        [title, description || null, difficulty, maxTeamSize, req.user.id, req.user.role]
      );
      res.json({
        message: "Team todo created.",
        teamTodo: {
          id: result.insertId,
          title,
          description: description || null,
          difficulty,
          maxTeamSize,
          status: "open",
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error creating team todo." });
    }
  });

  // 📋 All team todos (admin view)
  router.get("/admin/team-todos", adminRateLimit, requireRank(4), async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT
           tt.id,
           tt.title,
           tt.description,
           tt.difficulty,
           tt.status,
           tt.max_team_size,
           tt.created_by_user_id,
           creator.username AS created_by_username,
           tt.claimed_by_user_id,
           claimer.username AS claimed_by_username,
           tt.claimed_todo_id,
           tt.completion_notes,
           tt.completed_by_user_id,
           completer.username AS completed_by_username,
           tt.completed_at,
           tt.claimed_at,
           tt.created_at,
           COUNT(DISTINCT tm.user_id) AS member_count,
           (
             SELECT COUNT(*)
             FROM team_todo_messages tmsg
             WHERE tmsg.team_todo_id = tt.id
           ) AS message_count
         FROM team_todos tt
         INNER JOIN users creator ON creator.id = tt.created_by_user_id
         LEFT JOIN users claimer ON claimer.id = tt.claimed_by_user_id
         LEFT JOIN users completer ON completer.id = tt.completed_by_user_id
         LEFT JOIN team_todo_members tm ON tm.team_todo_id = tt.id
         GROUP BY
           tt.id,
           tt.title,
           tt.description,
           tt.difficulty,
           tt.status,
           tt.max_team_size,
           tt.created_by_user_id,
           creator.username,
           tt.claimed_by_user_id,
           claimer.username,
           tt.claimed_todo_id,
           tt.completion_notes,
           tt.completed_by_user_id,
           completer.username,
           tt.completed_at,
           tt.claimed_at,
           tt.created_at
         ORDER BY tt.created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error fetching team todos." });
    }
  });

  // ➕ Add member to team todo (admin)
  router.post("/admin/team-todos/:id/members", adminRateLimit, requireRank(4), async (req, res) => {
    const teamTodoId = Number.parseInt(req.params.id, 10);
    const targetUserId = Number.parseInt(req.body?.userId, 10);
    if (!Number.isInteger(teamTodoId) || teamTodoId <= 0) {
      return res.status(400).json({ error: "Invalid team todo id." });
    }
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "Valid userId is required." });
    }

    try {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [todoRows] = await conn.query(
          `SELECT id, status
           FROM team_todos
           WHERE id = ?
           LIMIT 1
           FOR UPDATE`,
          [teamTodoId]
        );
        if (todoRows.length === 0) {
          await conn.rollback();
          return res.status(404).json({ error: "Team todo not found." });
        }
        if (String(todoRows[0].status || "") === "completed") {
          await conn.rollback();
          return res.status(400).json({ error: "Cannot modify members of a completed team todo." });
        }

        const [userRows] = await conn.query("SELECT id FROM users WHERE id = ? LIMIT 1", [targetUserId]);
        if (userRows.length === 0) {
          await conn.rollback();
          return res.status(404).json({ error: "User not found." });
        }

        const [existingMember] = await conn.query(
          "SELECT 1 FROM team_todo_members WHERE team_todo_id = ? AND user_id = ? LIMIT 1",
          [teamTodoId, targetUserId]
        );
        if (existingMember.length > 0) {
          await conn.rollback();
          return res.status(400).json({ error: "User is already on this team todo." });
        }

        await conn.query(
          "INSERT INTO team_todo_members (team_todo_id, user_id, joined_by_user_id) VALUES (?, ?, ?)",
          [teamTodoId, targetUserId, req.user.id]
        );
        await conn.query(
          `UPDATE team_todos
           SET status = 'claimed',
               claimed_by_user_id = COALESCE(claimed_by_user_id, ?),
               claimed_at = COALESCE(claimed_at, NOW())
           WHERE id = ?`,
          [targetUserId, teamTodoId]
        );
        await conn.commit();
        return res.json({ message: "User added to team todo." });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error adding user to team todo." });
    }
  });

  // ➖ Remove member from team todo (admin)
  router.delete("/admin/team-todos/:id/members/:userId", adminRateLimit, requireRank(4), async (req, res) => {
    const teamTodoId = Number.parseInt(req.params.id, 10);
    const targetUserId = Number.parseInt(req.params.userId, 10);
    if (!Number.isInteger(teamTodoId) || teamTodoId <= 0) {
      return res.status(400).json({ error: "Invalid team todo id." });
    }
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "Invalid user id." });
    }

    try {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [todoRows] = await conn.query(
          `SELECT id, status
           FROM team_todos
           WHERE id = ?
           LIMIT 1
           FOR UPDATE`,
          [teamTodoId]
        );
        if (todoRows.length === 0) {
          await conn.rollback();
          return res.status(404).json({ error: "Team todo not found." });
        }
        if (String(todoRows[0].status || "") === "completed") {
          await conn.rollback();
          return res.status(400).json({ error: "Cannot modify members of a completed team todo." });
        }

        const [removeResult] = await conn.query(
          "DELETE FROM team_todo_members WHERE team_todo_id = ? AND user_id = ?",
          [teamTodoId, targetUserId]
        );
        if (!removeResult.affectedRows) {
          await conn.rollback();
          return res.status(404).json({ error: "User is not a member of this team todo." });
        }

        const [memberCountRows] = await conn.query(
          "SELECT COUNT(*) AS memberCount FROM team_todo_members WHERE team_todo_id = ?",
          [teamTodoId]
        );
        const memberCount = Number(memberCountRows[0]?.memberCount || 0);
        if (memberCount === 0) {
          await conn.query(
            `UPDATE team_todos
             SET status = 'open',
                 claimed_by_user_id = NULL,
                 claimed_at = NULL
             WHERE id = ?`,
            [teamTodoId]
          );
        }

        await conn.commit();
        return res.json({ message: "User removed from team todo." });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error removing user from team todo." });
    }
  });

  return router;
};
