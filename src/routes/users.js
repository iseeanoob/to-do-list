const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimits");
const { getRequiredXpForLevel } = require("../helpers/xp");
const { MAX_DATA_URL_LENGTH, MAX_PROFILE_URL_LENGTH } = require("../config");

module.exports = function usersRouter(pool) {
  const router = express.Router();

  // 👤 Current user profile
  router.get("/me", userRateLimit, authenticateToken, async (req, res) => {
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
  router.put("/me/profile-picture", userRateLimit, authenticateToken, async (req, res) => {
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

  return router;
};
