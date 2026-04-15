const mysql = require("mysql2/promise");
const { DB_CONFIG, MAX_DATA_URL_LENGTH } = require("./config");

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

module.exports = { connectWithRetry };
