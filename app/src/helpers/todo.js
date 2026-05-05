const { TODO_DIFFICULTY_LEVELS, MIN_ADMIN_ROLE_LEVEL } = require("../config");

/**
 * Normalizes a difficulty string to one of the valid values.
 * @param {*} value - Raw difficulty value from user input.
 * @returns {string|null} Normalized difficulty or null if invalid.
 */
function normalizeDifficulty(value) {
  const normalized = String(value || "easy").trim().toLowerCase();
  return TODO_DIFFICULTY_LEVELS.includes(normalized) ? normalized : null;
}

/**
 * Parses and validates a team size value.
 * @param {*} value - Raw team size value from user input.
 * @returns {number|null} Integer between 1 and 20, or null if invalid.
 */
function normalizeTeamSize(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return null;
  return parsed >= 1 && parsed <= 20 ? parsed : null;
}

/**
 * Checks whether a user with assignerRole may assign todos to a user with targetRole.
 * @param {number} assignerRole - Role level of the assigning user.
 * @param {number} targetRole - Role level of the target user.
 * @returns {boolean}
 */
function canAssignTodo(assignerRole, targetRole) {
  if (assignerRole === 5) return targetRole <= 5;
  if (assignerRole === 4) return targetRole <= 4;
  return false;
}

/**
 * Verifies that a user has access to a team todo's message thread.
 * Members of the team todo and admins are allowed access.
 * @param {import("mysql2/promise").Pool} pool
 * @param {number} teamTodoId
 * @param {{ id: number, role: number }} user
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
async function ensureTeamTodoMessagingAccess(pool, teamTodoId, user) {
  const [todoRows] = await pool.query(
    "SELECT id FROM team_todos WHERE id = ? LIMIT 1",
    [teamTodoId]
  );
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

module.exports = {
  normalizeDifficulty,
  normalizeTeamSize,
  canAssignTodo,
  ensureTeamTodoMessagingAccess,
};
