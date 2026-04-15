const { TODO_DIFFICULTY_LEVELS, MIN_ADMIN_ROLE_LEVEL } = require("../config");

function normalizeDifficulty(value) {
  const normalized = String(value || "easy").trim().toLowerCase();
  return TODO_DIFFICULTY_LEVELS.includes(normalized) ? normalized : null;
}

function normalizeTeamSize(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return null;
  return parsed >= 1 && parsed <= 20 ? parsed : null;
}

function canAssignTodo(assignerRole, targetRole) {
  if (assignerRole === 5) return targetRole <= 5;
  if (assignerRole === 4) return targetRole <= 4;
  return false;
}

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
