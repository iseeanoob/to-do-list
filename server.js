const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret";

// DB config
const DB_CONFIG = {
  host: process.env.DB_HOST || "db",
  user: process.env.DB_USER || "iseeanoob",
  password: process.env.DB_PASSWORD || "pass",
  database: process.env.DB_NAME || "mydb",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

// Retry MySQL connection until successful
async function connectWithRetry(retries = 10, delay = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      const pool = mysql.createPool(DB_CONFIG);
      const conn = await pool.getConnection();
      console.log("✅ Connected to MySQL!");

      // Users table with role
      await conn.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(255) NOT NULL UNIQUE,
          email VARCHAR(255) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          role ENUM('user','admin') DEFAULT 'user'
        )
      `);

      // Todos table
      await conn.query(`
        CREATE TABLE IF NOT EXISTS todos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          title VARCHAR(255) NOT NULL,
          completed BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      conn.release();
      console.log("✅ Tables ready");
      return pool;
    } catch (err) {
      console.log(`❌ MySQL not ready (attempt ${i}/${retries}): ${err.code}`);
      if (i === retries) process.exit(1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

let pool;

// JWT middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access denied. No token." });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid or expired token." });
    req.user = user;
    next();
  });
}

// Admin middleware
function authenticateAdmin(req, res, next) {
  authenticateToken(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin access required." });
    next();
  });
}

(async () => {
  pool = await connectWithRetry();

  app.get("/", (req, res) => res.send("🚀 Node + MySQL App Running"));

  // REGISTER
  app.post("/register", async (req, res) => {
    const { username, email, password, role } = req.body; // optional role
    if (!username || !email || !password)
      return res.status(400).json({ error: "All fields are required." });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email))
      return res.status(400).json({ error: "Invalid email format." });

    try {
      const [existing] = await pool.query(
        "SELECT * FROM users WHERE email = ? OR username = ?",
        [email, username]
      );

      if (existing.length > 0) {
        const duplicate = existing[0];
        if (duplicate.email === email) return res.status(400).json({ error: "Email already exists." });
        if (duplicate.username === username) return res.status(400).json({ error: "Username already exists." });
      }

      const hashed = await bcrypt.hash(password, 10);
      const [result] = await pool.query(
        "INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)",
        [username, email, hashed, role || "user"]
      );

      const token = jwt.sign(
        { id: result.insertId, username, email, role: role || "user" },
        JWT_SECRET,
        { expiresIn: "1h" }
      );

      res.json({ message: "Registration successful", token, user: { id: result.insertId, username, email, role: role || "user" } });
    } catch (err) {
      console.error("Registration error:", err);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  // LOGIN
  app.post("/login", async (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password)
      return res.status(400).json({ error: "Please provide email/username and password." });

    try {
      const [users] = await pool.query(
        "SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1",
        [identifier, identifier]
      );

      if (users.length === 0) return res.status(401).json({ error: "Invalid credentials." });

      const user = users[0];
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) return res.status(401).json({ error: "Invalid credentials." });

      const token = jwt.sign(
        { id: user.id, username: user.username, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: "1h" }
      );

      res.json({ message: "Login successful", token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
    } catch (err) {
      console.error("Login error:", err);
      res.status(500).json({ error: "Server error during login." });
    }
  });

  // USER TODOs
  app.get("/todos", authenticateToken, async (req, res) => {
    try {
      const [rows] = await pool.query(
        "SELECT * FROM todos WHERE user_id = ? ORDER BY created_at DESC",
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      console.error("Get todos error:", err);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  app.post("/todos", authenticateToken, async (req, res) => {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: "Title is required." });

    try {
      const [result] = await pool.query(
        "INSERT INTO todos (user_id, title) VALUES (?, ?)",
        [req.user.id, title]
      );
      res.json({ id: result.insertId, user_id: req.user.id, title, completed: false });
    } catch (err) {
      console.error("Add todo error:", err);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  app.put("/todos/:id", authenticateToken, async (req, res) => {
    const todoId = req.params.id;
    const { title, completed } = req.body;

    try {
      const [rows] = await pool.query("SELECT * FROM todos WHERE id = ? AND user_id = ?", [todoId, req.user.id]);
      if (rows.length === 0) return res.status(403).json({ error: "Not authorized." });

      await pool.query("UPDATE todos SET title = ?, completed = ? WHERE id = ?", [title, completed, todoId]);
      res.json({ id: todoId, title, completed });
    } catch (err) {
      console.error("Update todo error:", err);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  app.delete("/todos/:id", authenticateToken, async (req, res) => {
    const todoId = req.params.id;

    try {
      const [rows] = await pool.query("SELECT * FROM todos WHERE id = ? AND user_id = ?", [todoId, req.user.id]);
      if (rows.length === 0) return res.status(403).json({ error: "Not authorized." });

      await pool.query("DELETE FROM todos WHERE id = ?", [todoId]);
      res.json({ message: "Todo deleted." });
    } catch (err) {
      console.error("Delete todo error:", err);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  // ADMIN: get all users with todos
  app.get("/admin/users-todos", authenticateAdmin, async (req, res) => {
    try {
      const [users] = await pool.query("SELECT id, username, email, role FROM users");

      const userTodos = await Promise.all(users.map(async user => {
        const [todos] = await pool.query("SELECT id, title, completed FROM todos WHERE user_id = ?", [user.id]);
        return { ...user, todos };
      }));

      res.json(userTodos);
    } catch (err) {
      console.error("Admin fetch error:", err);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
})();
