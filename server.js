const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret";
// 2,000,000 chars keeps profile images practical while staying below MEDIUMTEXT capacity.
const MAX_DATA_URL_LENGTH = 2000000;
const MAX_PROFILE_URL_LENGTH = 2048;
const MAX_COMPLETION_NOTES_LENGTH = 2000;
const MAX_TEAM_MESSAGE_LENGTH = 1000;

const DB_CONFIG = {
  host: process.env.DB_HOST || "db",
  user: process.env.DB_USER || "iseeanoob",
  password: process.env.DB_PASSWORD || "pass",
  database: process.env.DB_NAME || "mydb",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

let pool;

// 🧠 Connect to MySQL with retry logic
async function connectWithRetry(retries = 10, delay = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      const pool = mysql.createPool(DB_CONFIG);
      const conn = await pool.getConnection();
      console.log("✅ Connected to MySQL!");

      await conn.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(255) NOT NULL UNIQUE,
          email VARCHAR(255) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          role INT DEFAULT 1,
          profile_picture_url MEDIUMTEXT DEFAULT NULL,
          xp INT NOT NULL DEFAULT 0,
          level INT NOT NULL DEFAULT 1
        )
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS todos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          title VARCHAR(255) NOT NULL,
          completed BOOLEAN DEFAULT FALSE,
          completion_requested BOOLEAN NOT NULL DEFAULT FALSE,
          completion_notes TEXT DEFAULT NULL,
          completion_reviewed_by_user_id INT DEFAULT NULL,
          completion_reviewed_at TIMESTAMP NULL DEFAULT NULL,
          difficulty ENUM('easy', 'medium', 'hard', 'insane') NOT NULL DEFAULT 'easy',
          xp_awarded BOOLEAN NOT NULL DEFAULT FALSE,
          assigned_by_user_id INT DEFAULT NULL,
          assigned_by_role INT DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS todo_requests (
          id INT AUTO_INCREMENT PRIMARY KEY,
          requested_by_user_id INT NOT NULL,
          title VARCHAR(255) NOT NULL,
          difficulty ENUM('easy', 'medium', 'hard', 'insane') NOT NULL DEFAULT 'easy',
          status ENUM('pending', 'distributed') NOT NULL DEFAULT 'pending',
          distributed_to_user_id INT DEFAULT NULL,
          distributed_todo_id INT DEFAULT NULL,
          handled_by_user_id INT DEFAULT NULL,
          handled_at TIMESTAMP NULL DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS team_todos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          description TEXT DEFAULT NULL,
          difficulty ENUM('easy', 'medium', 'hard', 'insane') NOT NULL DEFAULT 'easy',
          status ENUM('open', 'claimed', 'completed') NOT NULL DEFAULT 'open',
          max_team_size INT NOT NULL DEFAULT 3,
          created_by_user_id INT NOT NULL,
          created_by_role INT NOT NULL,
          claimed_by_user_id INT DEFAULT NULL,
          claimed_todo_id INT DEFAULT NULL,
          completion_notes TEXT DEFAULT NULL,
          completed_by_user_id INT DEFAULT NULL,
          completed_at TIMESTAMP NULL DEFAULT NULL,
          claimed_at TIMESTAMP NULL DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS team_todo_members (
          team_todo_id INT NOT NULL,
          user_id INT NOT NULL,
          joined_by_user_id INT NOT NULL,
          joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (team_todo_id, user_id),
          FOREIGN KEY (team_todo_id) REFERENCES team_todos(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (joined_by_user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS team_todo_messages (
          id INT AUTO_INCREMENT PRIMARY KEY,
          team_todo_id INT NOT NULL,
          user_id INT NOT NULL,
          message TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (team_todo_id) REFERENCES team_todos(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      const [usersProfilePictureColumn] = await conn.query(
        `SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'profile_picture_url'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (usersProfilePictureColumn.length === 0) {
        await conn.query("ALTER TABLE users ADD COLUMN profile_picture_url MEDIUMTEXT DEFAULT NULL");
      } else if (
        usersProfilePictureColumn[0].DATA_TYPE === "varchar" &&
        Number(usersProfilePictureColumn[0].CHARACTER_MAXIMUM_LENGTH || 0) < MAX_DATA_URL_LENGTH
      ) {
        await conn.query("ALTER TABLE users MODIFY COLUMN profile_picture_url MEDIUMTEXT DEFAULT NULL");
      }

      const [todosAssignedByUserColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todos' AND COLUMN_NAME = 'assigned_by_user_id'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todosAssignedByUserColumn.length === 0) {
        await conn.query("ALTER TABLE todos ADD COLUMN assigned_by_user_id INT DEFAULT NULL");
      }

      const [todosAssignedByRoleColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todos' AND COLUMN_NAME = 'assigned_by_role'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todosAssignedByRoleColumn.length === 0) {
        await conn.query("ALTER TABLE todos ADD COLUMN assigned_by_role INT DEFAULT NULL");
      }

      const [todosDifficultyColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todos' AND COLUMN_NAME = 'difficulty'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todosDifficultyColumn.length === 0) {
        await conn.query(
          "ALTER TABLE todos ADD COLUMN difficulty ENUM('easy', 'medium', 'hard', 'insane') NOT NULL DEFAULT 'easy'"
        );
      }

      const [todosXpAwardedColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todos' AND COLUMN_NAME = 'xp_awarded'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todosXpAwardedColumn.length === 0) {
        await conn.query("ALTER TABLE todos ADD COLUMN xp_awarded BOOLEAN NOT NULL DEFAULT FALSE");
      }

      const [todosCompletionRequestedColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todos' AND COLUMN_NAME = 'completion_requested'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todosCompletionRequestedColumn.length === 0) {
        await conn.query("ALTER TABLE todos ADD COLUMN completion_requested BOOLEAN NOT NULL DEFAULT FALSE");
      }
      const [todosCompletionNotesColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todos' AND COLUMN_NAME = 'completion_notes'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todosCompletionNotesColumn.length === 0) {
        await conn.query("ALTER TABLE todos ADD COLUMN completion_notes TEXT DEFAULT NULL");
      }
      const [todosCompletionReviewedByColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todos' AND COLUMN_NAME = 'completion_reviewed_by_user_id'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todosCompletionReviewedByColumn.length === 0) {
        await conn.query("ALTER TABLE todos ADD COLUMN completion_reviewed_by_user_id INT DEFAULT NULL");
      }
      const [todosCompletionReviewedAtColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todos' AND COLUMN_NAME = 'completion_reviewed_at'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todosCompletionReviewedAtColumn.length === 0) {
        await conn.query("ALTER TABLE todos ADD COLUMN completion_reviewed_at TIMESTAMP NULL DEFAULT NULL");
      }

      const [usersXpColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'xp'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (usersXpColumn.length === 0) {
        await conn.query("ALTER TABLE users ADD COLUMN xp INT NOT NULL DEFAULT 0");
      }

      const [usersLevelColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'level'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (usersLevelColumn.length === 0) {
        await conn.query("ALTER TABLE users ADD COLUMN level INT NOT NULL DEFAULT 1");
      }
      const [todoRequestsDifficultyColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todo_requests' AND COLUMN_NAME = 'difficulty'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todoRequestsDifficultyColumn.length === 0) {
        await conn.query(
          "ALTER TABLE todo_requests ADD COLUMN difficulty ENUM('easy', 'medium', 'hard', 'insane') NOT NULL DEFAULT 'easy'"
        );
      }
      const [todoRequestsStatusColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todo_requests' AND COLUMN_NAME = 'status'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todoRequestsStatusColumn.length === 0) {
        await conn.query(
          "ALTER TABLE todo_requests ADD COLUMN status ENUM('pending', 'distributed') NOT NULL DEFAULT 'pending'"
        );
      }
      const [todoRequestsDistributedToUserColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todo_requests' AND COLUMN_NAME = 'distributed_to_user_id'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todoRequestsDistributedToUserColumn.length === 0) {
        await conn.query("ALTER TABLE todo_requests ADD COLUMN distributed_to_user_id INT DEFAULT NULL");
      }
      const [todoRequestsDistributedTodoColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todo_requests' AND COLUMN_NAME = 'distributed_todo_id'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todoRequestsDistributedTodoColumn.length === 0) {
        await conn.query("ALTER TABLE todo_requests ADD COLUMN distributed_todo_id INT DEFAULT NULL");
      }
      const [todoRequestsHandledByColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todo_requests' AND COLUMN_NAME = 'handled_by_user_id'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todoRequestsHandledByColumn.length === 0) {
        await conn.query("ALTER TABLE todo_requests ADD COLUMN handled_by_user_id INT DEFAULT NULL");
      }
      const [todoRequestsHandledAtColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'todo_requests' AND COLUMN_NAME = 'handled_at'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (todoRequestsHandledAtColumn.length === 0) {
        await conn.query("ALTER TABLE todo_requests ADD COLUMN handled_at TIMESTAMP NULL DEFAULT NULL");
      }
      const [teamTodosMaxTeamSizeColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'team_todos' AND COLUMN_NAME = 'max_team_size'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (teamTodosMaxTeamSizeColumn.length === 0) {
        await conn.query("ALTER TABLE team_todos ADD COLUMN max_team_size INT NOT NULL DEFAULT 3");
      }
      await conn.query(
        "ALTER TABLE team_todos MODIFY COLUMN status ENUM('open', 'claimed', 'completed') NOT NULL DEFAULT 'open'"
      );
      const [teamTodosCompletionNotesColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'team_todos' AND COLUMN_NAME = 'completion_notes'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (teamTodosCompletionNotesColumn.length === 0) {
        await conn.query("ALTER TABLE team_todos ADD COLUMN completion_notes TEXT DEFAULT NULL");
      }
      const [teamTodosCompletedByColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'team_todos' AND COLUMN_NAME = 'completed_by_user_id'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (teamTodosCompletedByColumn.length === 0) {
        await conn.query("ALTER TABLE team_todos ADD COLUMN completed_by_user_id INT DEFAULT NULL");
      }
      const [teamTodosCompletedAtColumn] = await conn.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'team_todos' AND COLUMN_NAME = 'completed_at'
         LIMIT 1`,
        [DB_CONFIG.database]
      );
      if (teamTodosCompletedAtColumn.length === 0) {
        await conn.query("ALTER TABLE team_todos ADD COLUMN completed_at TIMESTAMP NULL DEFAULT NULL");
      }

      conn.release();
      console.log("✅ Tables ready");
      return pool;
    } catch (err) {
      console.error(`❌ MySQL not ready (attempt ${i}/${retries}): ${err.code}`);
      if (i === retries) process.exit(1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// 🔒 JWT Authentication
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided." });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token." });
    req.user = user;
    next();
  });
}

// 👑 Role-based middleware
function requireRank(minRank) {
  return (req, res, next) => {
    authenticateToken(req, res, () => {
      if (req.user.role < minRank)
        return res.status(403).json({ error: "Insufficient privileges." });
      next();
    });
  };
}

const ROLES = {
  1: "user",
  2: "moderator",
  3: "manager",
  4: "admin",
  5: "superadmin",
};
const MIN_ADMIN_ROLE_LEVEL = 4;

const TODO_DIFFICULTY_LEVELS = ["easy", "medium", "hard", "insane"];
const TODO_DIFFICULTY_XP = {
  easy: 5,
  medium: 10,
  hard: 20,
  insane: 40,
};
const TODO_DEFAULT_COMPLETED = false;
const TODO_DEFAULT_COMPLETION_REQUESTED = false;

  function normalizeDifficulty(value) {
    const normalized = String(value || "easy").trim().toLowerCase();
    return TODO_DIFFICULTY_LEVELS.includes(normalized) ? normalized : null;
  }

  function normalizeTeamSize(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) return null;
    return parsed >= 1 && parsed <= 20 ? parsed : null;
  }

  async function ensureTeamTodoMessagingAccess(teamTodoId, user) {
    const [todoRows] = await pool.query("SELECT id FROM team_todos WHERE id = ? LIMIT 1", [teamTodoId]);
    if (todoRows.length === 0) {
      return { ok: false, status: 404, error: "Team todo not found." };
    }

    const [membershipRows] = await pool.query(
      "SELECT 1 FROM team_todo_members WHERE team_todo_id = ? AND user_id = ? LIMIT 1",
      [teamTodoId, user.id]
    );
    if (membershipRows.length === 0 && Number(user.role) < MIN_ADMIN_ROLE_LEVEL) {
      return { ok: false, status: 403, error: "Join the team todo first to access messages." };
    }
    return { ok: true };
  }

function getRequiredXpForLevel(level) {
  return Math.max(10, Number(level) * 10);
}

function applyXpProgression(currentXp, currentLevel, gainedXp) {
  let xp = Number(currentXp) + Number(gainedXp);
  let level = Math.max(1, Number(currentLevel) || 1);
  let required = getRequiredXpForLevel(level);

  while (xp >= required) {
    xp -= required;
    level += 1;
    required = getRequiredXpForLevel(level);
  }

  return { xp, level };
}

/**
 * Awards XP to unique user IDs using todo difficulty XP values.
 * @returns {{ xpPerUser: number, rewards: Array<{ userId: number, xpGained: number, xp: number, level: number }> }}
 */
async function awardXpToUsers(conn, userIds, difficulty) {
  const normalizedDifficulty = normalizeDifficulty(difficulty) || "easy";
  const xpPerUser = TODO_DIFFICULTY_XP[normalizedDifficulty];
  const uniqueUserIds = Array.from(
    new Set(
      (Array.isArray(userIds) ? userIds : [])
        .map((id) => Number.parseInt(id, 10))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  if (!uniqueUserIds.length) {
    return { xpPerUser, rewards: [] };
  }

  const [users] = await conn.query(
    "SELECT id, xp, level FROM users WHERE id IN (?) FOR UPDATE",
    [uniqueUserIds]
  );
  const rewards = [];
  for (const user of users) {
    const progression = applyXpProgression(user.xp, user.level, xpPerUser);
    await conn.query("UPDATE users SET xp = ?, level = ? WHERE id = ?", [
      progression.xp,
      progression.level,
      user.id,
    ]);
    rewards.push({
      userId: user.id,
      xpGained: xpPerUser,
      xp: progression.xp,
      level: progression.level,
    });
  }
  return { xpPerUser, rewards };
}

function canAssignTodo(assignerRole, targetRole) {
  if (assignerRole === 5) return targetRole <= 5;
  if (assignerRole === 4) return targetRole <= 4;
  return false;
}

const adminRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const userRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const { registerRoutes } = require("./src/registerRoutes");

(async () => {
  pool = await connectWithRetry();

  registerRoutes(app, {
    pool,
    JWT_SECRET,
    authenticateToken,
    requireRank,
    userRateLimit,
    adminRateLimit,
    normalizeDifficulty,
    normalizeTeamSize,
    canAssignTodo,
    getRequiredXpForLevel,
    applyXpProgression,
    awardXpToUsers,
    ensureTeamTodoMessagingAccess,
    MAX_DATA_URL_LENGTH,
    MAX_PROFILE_URL_LENGTH,
    MAX_COMPLETION_NOTES_LENGTH,
    MAX_TEAM_MESSAGE_LENGTH,
    TODO_DEFAULT_COMPLETED,
    TODO_DEFAULT_COMPLETION_REQUESTED,
    TODO_DIFFICULTY_XP,
    ROLES,
    MIN_ADMIN_ROLE_LEVEL,
  });

  app.listen(PORT, () =>
    console.log(`🚀 Server running on http://localhost:${PORT}`)
  );
})();
