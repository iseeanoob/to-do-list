const PORT = process.env.PORT || 3001;
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

module.exports = {
  PORT,
  JWT_SECRET,
  MAX_DATA_URL_LENGTH,
  MAX_PROFILE_URL_LENGTH,
  MAX_COMPLETION_NOTES_LENGTH,
  MAX_TEAM_MESSAGE_LENGTH,
  DB_CONFIG,
  ROLES,
  MIN_ADMIN_ROLE_LEVEL,
  TODO_DIFFICULTY_LEVELS,
  TODO_DIFFICULTY_XP,
  TODO_DEFAULT_COMPLETED,
  TODO_DEFAULT_COMPLETION_REQUESTED,
};
