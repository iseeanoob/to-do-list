const { TODO_DIFFICULTY_XP } = require("../config");
const { normalizeDifficulty } = require("./todo");

/**
 * Returns the XP required to advance from the given level to the next.
 * @param {number} level
 * @returns {number}
 */
function getRequiredXpForLevel(level) {
  return Math.max(10, Number(level) * 10);
}

/**
 * Applies gained XP to a user's current XP/level, advancing levels as needed.
 * @param {number} currentXp
 * @param {number} currentLevel
 * @param {number} gainedXp
 * @returns {{ xp: number, level: number }}
 */
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

module.exports = { getRequiredXpForLevel, applyXpProgression, awardXpToUsers };
