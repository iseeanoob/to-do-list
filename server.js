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
          status ENUM('open', 'claimed') NOT NULL DEFAULT 'open',
          created_by_user_id INT NOT NULL,
          created_by_role INT NOT NULL,
          claimed_by_user_id INT DEFAULT NULL,
          claimed_todo_id INT DEFAULT NULL,
          claimed_at TIMESTAMP NULL DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
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

(async () => {
  pool = await connectWithRetry();

  app.get("/", (req, res) => res.send("🚀 Node + MySQL App Running"));

  // 🧾 Register
  app.post("/register", async (req, res) => {
    const { username, email, password, role } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: "All fields required." });

    try {
      const [existing] = await pool.query(
        "SELECT * FROM users WHERE email = ? OR username = ?",
        [email, username]
      );
      if (existing.length > 0)
        return res
          .status(400)
          .json({ error: "Email or username already in use." });

      const hashed = await bcrypt.hash(password, 10);
      const [result] = await pool.query(
        "INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)",
        [username, email, hashed, role || 1]
      );

      const token = jwt.sign(
        { id: result.insertId, username, email, role: role || 1 },
        JWT_SECRET,
        { expiresIn: "1h" }
      );

      res.json({
        message: "Registration successful",
        token,
        user: { id: result.insertId, username, email, role: role || 1 },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  // 🔑 Login
  app.post("/login", async (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password)
      return res.status(400).json({ error: "Missing credentials." });

    try {
      const [users] = await pool.query(
        "SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1",
        [identifier, identifier]
      );
      if (users.length === 0)
        return res.status(401).json({ error: "Invalid credentials." });

      const user = users[0];
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: "Invalid credentials." });

      const token = jwt.sign(
        {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
        },
        JWT_SECRET,
        { expiresIn: "1h" }
      );

      res.json({
        message: "Login successful",
        token,
        user: { id: user.id, username: user.username, role: user.role },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  // ✅ Get todos
  app.get("/todos", authenticateToken, async (req, res) => {
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

  // 👤 Current user profile
  app.get("/me", userRateLimit, authenticateToken, async (req, res) => {
    try {
      const [rows] = await pool.query(
        "SELECT id, username, email, role, profile_picture_url, xp, level FROM users WHERE id = ? LIMIT 1",
        [req.user.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "User not found." });

      const user = rows[0];
      res.json({
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        xp: user.xp,
        level: user.level,
        nextLevelXp: getRequiredXpForLevel(user.level),
        profilePictureUrl: user.profile_picture_url,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error fetching profile." });
    }
  });

  // 🖼️ Update profile picture URL
  app.put("/me/profile-picture", userRateLimit, authenticateToken, async (req, res) => {
    const rawUrl = typeof req.body?.profilePictureUrl === "string" ? req.body.profilePictureUrl.trim() : "";
    const isEmpty = rawUrl.length === 0;
    const isDataUrlCandidate = rawUrl.startsWith("data:image/");
    let isValidUrl = false;

    if (isEmpty) {
      isValidUrl = true;
    } else if (isDataUrlCandidate) {
      if (rawUrl.length > MAX_DATA_URL_LENGTH) {
        return res.status(400).json({ error: "Data URL image is too large." });
      }
      isValidUrl = /^data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+$/.test(rawUrl);
    } else {
      if (rawUrl.length > MAX_PROFILE_URL_LENGTH) {
        return res.status(400).json({ error: "Profile picture URL is too long." });
      }
      try {
        const parsed = new URL(rawUrl);
        isValidUrl = parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        isValidUrl = false;
      }
    }

    if (!isValidUrl) {
      return res.status(400).json({ error: "Provide a valid image URL or data URL." });
    }
    try {
      const newValue = isEmpty ? null : rawUrl;
      await pool.query("UPDATE users SET profile_picture_url = ? WHERE id = ?", [
        newValue,
        req.user.id,
      ]);
      res.json({ message: "Profile picture updated.", profilePictureUrl: newValue });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error updating profile picture." });
    }
  });

  // ➕ Add todo
  app.post("/todos", authenticateToken, async (req, res) => {
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
  app.put("/todos/:id", userRateLimit, authenticateToken, async (req, res) => {
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
          }
        }
        if (hasCompletionNotes && !hasCompleted) {
          await conn.rollback();
          return res.status(400).json({ error: "Completion notes can only be set while requesting completion." });
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
          return res.json({
            message: "Todo unchanged.",
            xpGained: 0,
          });
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
        return res.json({
          message: "Todo updated.",
          xpGained: 0,
        });
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
  app.delete("/todos/:id", userRateLimit, authenticateToken, async (req, res) => {
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

  app.get("/todo-requests", userRateLimit, authenticateToken, async (req, res) => {
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

  app.post("/todo-requests", userRateLimit, authenticateToken, async (req, res) => {
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

  // 🧑‍💼 Admin panel: users + todos
  app.get("/admin/users-todos", adminRateLimit, requireRank(4), async (req, res) => {
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

  // 📝 Assign todo to a user (admin/superadmin)
  app.post("/admin/users/:id/todos", adminRateLimit, requireRank(4), async (req, res) => {
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

  app.get("/admin/todo-requests", adminRateLimit, requireRank(4), async (req, res) => {
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

  app.get("/admin/pending-approvals", adminRateLimit, requireRank(4), async (req, res) => {
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

  app.post("/admin/todo-requests/:id/distribute", adminRateLimit, requireRank(4), async (req, res) => {
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

  // ✅ Approve pending todo completion (admin/superadmin)
  app.put("/admin/todos/:id/approve", adminRateLimit, requireRank(4), async (req, res) => {
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

  // 🔺 Promote/Demote (Option 1 logic)
  app.put("/admin/role/:id", adminRateLimit, requireRank(4), async (req, res) => {
    const { id } = req.params;
    const { newRole } = req.body;

    if (!newRole || newRole < 1 || newRole > 5)
      return res.status(400).json({ error: "Invalid role value (1-5)." });

    try {
      const [rows] = await pool.query("SELECT role FROM users WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "User not found." });

      const targetRole = rows[0].role;

      // Option 1: allow promotion/demotion up to one rank below your own role
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
  app.delete("/admin/users/:id", adminRateLimit, requireRank(4), async (req, res) => {
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

  app.get("/team-todos", userRateLimit, authenticateToken, async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT
           tt.id,
           tt.title,
           tt.description,
           tt.difficulty,
           tt.status,
           tt.created_by_user_id,
           creator.username AS created_by_username,
           tt.claimed_by_user_id,
           claimer.username AS claimed_by_username,
           tt.claimed_todo_id,
           tt.claimed_at,
           tt.created_at
         FROM team_todos tt
         INNER JOIN users creator ON creator.id = tt.created_by_user_id
         LEFT JOIN users claimer ON claimer.id = tt.claimed_by_user_id
         ORDER BY (tt.status = 'open') DESC, tt.created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error fetching team todos." });
    }
  });

  app.post("/admin/team-todos", adminRateLimit, requireRank(4), async (req, res) => {
    const title = String(req.body?.title || "").trim();
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
    const difficulty = normalizeDifficulty(req.body?.difficulty);
    if (!title) return res.status(400).json({ error: "Title required." });
    if (!difficulty) return res.status(400).json({ error: "Difficulty must be easy, medium, hard, or insane." });

    try {
      const [result] = await pool.query(
        "INSERT INTO team_todos (title, description, difficulty, created_by_user_id, created_by_role) VALUES (?, ?, ?, ?, ?)",
        [title, description || null, difficulty, req.user.id, req.user.role]
      );
      res.json({
        message: "Team todo created.",
        teamTodo: {
          id: result.insertId,
          title,
          description: description || null,
          difficulty,
          status: "open",
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error creating team todo." });
    }
  });

  app.get("/admin/team-todos", adminRateLimit, requireRank(4), async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT
           tt.id,
           tt.title,
           tt.description,
           tt.difficulty,
           tt.status,
           tt.created_by_user_id,
           creator.username AS created_by_username,
           tt.claimed_by_user_id,
           claimer.username AS claimed_by_username,
           tt.claimed_todo_id,
           tt.claimed_at,
           tt.created_at
         FROM team_todos tt
         INNER JOIN users creator ON creator.id = tt.created_by_user_id
         LEFT JOIN users claimer ON claimer.id = tt.claimed_by_user_id
         ORDER BY tt.created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error fetching team todos." });
    }
  });

  app.post("/team-todos/:id/claim", userRateLimit, authenticateToken, async (req, res) => {
    const teamTodoId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(teamTodoId) || teamTodoId <= 0) {
      return res.status(400).json({ error: "Invalid team todo id." });
    }
    try {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
          `SELECT id, title, difficulty, status, created_by_user_id, created_by_role
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
        if (teamTodo.status !== "open") {
          await conn.rollback();
          return res.status(400).json({ error: "Team todo has already been claimed." });
        }
        const [todoResult] = await conn.query(
          "INSERT INTO todos (user_id, title, difficulty, assigned_by_user_id, assigned_by_role) VALUES (?, ?, ?, ?, ?)",
          [req.user.id, teamTodo.title, teamTodo.difficulty, teamTodo.created_by_user_id, teamTodo.created_by_role]
        );
        await conn.query(
          `UPDATE team_todos
           SET status = 'claimed',
               claimed_by_user_id = ?,
               claimed_todo_id = ?,
               claimed_at = NOW()
           WHERE id = ?`,
          [req.user.id, todoResult.insertId, teamTodoId]
        );
        await conn.commit();
        return res.json({
          message: "Team todo claimed successfully.",
          todo: {
            id: todoResult.insertId,
            title: teamTodo.title,
            difficulty: teamTodo.difficulty,
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
      res.status(500).json({ error: "Error claiming team todo." });
    }
  });

  // 🧙‍♂️ Create first superadmin (one-time use)
  app.post("/create-superadmin", async (req, res) => {
    const { secret, username, email, password } = req.body;
    if (secret !== "bootstrapSecret123")
      return res.status(403).json({ error: "Forbidden" });

    try {
      const [existing] = await pool.query("SELECT * FROM users WHERE role = 5");
      if (existing.length > 0)
        return res.status(400).json({ error: "Superadmin already exists." });

      const hashed = await bcrypt.hash(password, 10);
      const [result] = await pool.query(
        "INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, 5)",
        [username, email, hashed]
      );
      res.json({ message: "Superadmin created", id: result.insertId });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error creating superadmin." });
    }
  });

  app.listen(PORT, () =>
    console.log(`🚀 Server running on http://localhost:${PORT}`)
  );
})();
