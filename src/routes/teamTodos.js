const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimits");
const { ensureTeamTodoMessagingAccess } = require("../helpers/todo");
const { awardXpToUsers } = require("../helpers/xp");
const {
  MIN_ADMIN_ROLE_LEVEL,
  MAX_COMPLETION_NOTES_LENGTH,
  MAX_TEAM_MESSAGE_LENGTH,
} = require("../config");

module.exports = function teamTodosRouter(pool) {
  const router = express.Router();

  // 📋 List all team todos (user view)
  router.get("/team-todos", userRateLimit, authenticateToken, async (req, res) => {
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
           ) AS message_count,
           MAX(CASE WHEN tm.user_id = ? THEN 1 ELSE 0 END) AS current_user_is_member
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
         ORDER BY (COUNT(DISTINCT tm.user_id) < tt.max_team_size) DESC, tt.created_at DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error fetching team todos." });
    }
  });

  // 🤝 Join/claim a team todo
  const joinTeamTodoHandler = async (req, res) => {
    const teamTodoId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(teamTodoId) || teamTodoId <= 0) {
      return res.status(400).json({ error: "Invalid team todo id." });
    }
    try {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
          `SELECT id, title, difficulty, status, max_team_size, created_by_user_id, created_by_role
           FROM team_todos
           WHERE id = ?
           LIMIT 1
           FOR UPDATE`,
          [teamTodoId]
        );
        if (rows.length === 0) {
          await conn.rollback();
          return res.status(404).json({ error: "Team todo not found." });
        }
        const teamTodo = rows[0];
        const [existingMember] = await conn.query(
          "SELECT 1 FROM team_todo_members WHERE team_todo_id = ? AND user_id = ? LIMIT 1",
          [teamTodoId, req.user.id]
        );
        if (existingMember.length > 0) {
          await conn.rollback();
          return res.status(400).json({ error: "You are already part of this team todo." });
        }
        const [memberCountRows] = await conn.query(
          "SELECT COUNT(*) AS memberCount FROM team_todo_members WHERE team_todo_id = ? FOR UPDATE",
          [teamTodoId]
        );
        const memberCount = Number(memberCountRows[0]?.memberCount || 0);
        if (teamTodo.status === "completed") {
          await conn.rollback();
          return res.status(400).json({ error: "This team todo is already completed." });
        }
        if (memberCount >= Number(teamTodo.max_team_size || 3)) {
          await conn.rollback();
          return res.status(400).json({ error: "This team is already full." });
        }
        await conn.query(
          "INSERT INTO team_todo_members (team_todo_id, user_id, joined_by_user_id) VALUES (?, ?, ?)",
          [teamTodoId, req.user.id, req.user.id]
        );
        await conn.query(
          `UPDATE team_todos
           SET status = 'claimed',
               claimed_by_user_id = COALESCE(claimed_by_user_id, ?),
               claimed_at = COALESCE(claimed_at, NOW())
           WHERE id = ?`,
          [req.user.id, teamTodoId]
        );
        await conn.commit();
        return res.json({ message: "Joined team todo successfully." });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error joining team todo." });
    }
  };

  router.post("/team-todos/:id/join", userRateLimit, authenticateToken, joinTeamTodoHandler);
  router.post("/team-todos/:id/claim", userRateLimit, authenticateToken, joinTeamTodoHandler);

  // ✅ Complete a team todo
  router.post("/team-todos/:id/complete", userRateLimit, authenticateToken, async (req, res) => {
    const teamTodoId = Number.parseInt(req.params.id, 10);
    const completionNotes = typeof req.body?.completionNotes === "string"
      ? String(req.body.completionNotes || "").trim()
      : "";
    if (!Number.isInteger(teamTodoId) || teamTodoId <= 0) {
      return res.status(400).json({ error: "Invalid team todo id." });
    }
    if (completionNotes.length > MAX_COMPLETION_NOTES_LENGTH) {
      return res.status(400).json({ error: `Completion notes must be ${MAX_COMPLETION_NOTES_LENGTH} characters or less.` });
    }
    try {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
          `SELECT id, status, difficulty
           FROM team_todos
           WHERE id = ?
           LIMIT 1
           FOR UPDATE`,
          [teamTodoId]
        );
        if (rows.length === 0) {
          await conn.rollback();
          return res.status(404).json({ error: "Team todo not found." });
        }
        const teamTodo = rows[0];
        if (teamTodo.status === "completed") {
          await conn.rollback();
          return res.status(400).json({ error: "Team todo is already completed." });
        }
        const [memberRows] = await conn.query(
          "SELECT 1 FROM team_todo_members WHERE team_todo_id = ? AND user_id = ? LIMIT 1",
          [teamTodoId, req.user.id]
        );
        const isMember = memberRows.length > 0;
        const isAdmin = Number(req.user.role) >= MIN_ADMIN_ROLE_LEVEL;
        if (!isMember && !isAdmin) {
          await conn.rollback();
          return res.status(403).json({ error: "Join the team todo first to complete it." });
        }
        await conn.query(
          `UPDATE team_todos
           SET status = 'completed',
               completed_by_user_id = ?,
               completed_at = NOW(),
               completion_notes = ?
           WHERE id = ?`,
          [req.user.id, completionNotes || null, teamTodoId]
        );
        const [memberRowsForReward] = await conn.query(
          "SELECT user_id FROM team_todo_members WHERE team_todo_id = ?",
          [teamTodoId]
        );
        const rewardUserIds = memberRowsForReward.map((row) => row.user_id);
        const rewardResult = await awardXpToUsers(conn, rewardUserIds, teamTodo.difficulty);
        await conn.commit();
        const rewardedCount = rewardResult.rewards.length;
        const totalXpGained = rewardResult.xpPerUser * rewardedCount;
        return res.json({
          message: rewardedCount > 0
            ? `Team todo completed. ${rewardResult.xpPerUser} XP awarded to ${rewardedCount} team member(s).`
            : "Team todo completed.",
          xpPerUser: rewardResult.xpPerUser,
          rewardedCount,
          totalXpGained,
          rewards: rewardResult.rewards,
        });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error completing team todo." });
    }
  });

  // 👥 Get team todo members
  router.get("/team-todos/:id/members", userRateLimit, authenticateToken, async (req, res) => {
    const teamTodoId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(teamTodoId) || teamTodoId <= 0) {
      return res.status(400).json({ error: "Invalid team todo id." });
    }
    try {
      const [todoRows] = await pool.query(
        "SELECT id FROM team_todos WHERE id = ? LIMIT 1",
        [teamTodoId]
      );
      if (todoRows.length === 0) return res.status(404).json({ error: "Team todo not found." });
      const [rows] = await pool.query(
        `SELECT ttm.user_id, u.username, ttm.joined_at
         FROM team_todo_members ttm
         INNER JOIN users u ON u.id = ttm.user_id
         WHERE ttm.team_todo_id = ?
         ORDER BY ttm.joined_at ASC`,
        [teamTodoId]
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error fetching team members." });
    }
  });

  // 💬 Get team todo messages
  router.get("/team-todos/:id/messages", userRateLimit, authenticateToken, async (req, res) => {
    const teamTodoId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(teamTodoId) || teamTodoId <= 0) {
      return res.status(400).json({ error: "Invalid team todo id." });
    }
    try {
      const access = await ensureTeamTodoMessagingAccess(pool, teamTodoId, req.user);
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const [rows] = await pool.query(
        `SELECT tmsg.id, tmsg.message, tmsg.created_at, tmsg.user_id, u.username
         FROM team_todo_messages tmsg
         INNER JOIN users u ON u.id = tmsg.user_id
         WHERE tmsg.team_todo_id = ?
         ORDER BY tmsg.created_at ASC
         LIMIT 200`,
        [teamTodoId]
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error fetching team messages." });
    }
  });

  // 📨 Send a team todo message
  router.post("/team-todos/:id/messages", userRateLimit, authenticateToken, async (req, res) => {
    const teamTodoId = Number.parseInt(req.params.id, 10);
    const message = String(req.body?.message || "").trim();
    if (!Number.isInteger(teamTodoId) || teamTodoId <= 0) {
      return res.status(400).json({ error: "Invalid team todo id." });
    }
    if (!message) return res.status(400).json({ error: "Message is required." });
    if (message.length > MAX_TEAM_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message must be ${MAX_TEAM_MESSAGE_LENGTH} characters or less.` });
    }
    try {
      const access = await ensureTeamTodoMessagingAccess(pool, teamTodoId, req.user);
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const [result] = await pool.query(
        "INSERT INTO team_todo_messages (team_todo_id, user_id, message) VALUES (?, ?, ?)",
        [teamTodoId, req.user.id, message]
      );
      res.json({
        message: "Message sent.",
        teamMessage: {
          id: result.insertId,
          teamTodoId,
          userId: req.user.id,
          username: req.user.username,
          message,
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error sending team message." });
    }
  });

  return router;
};
