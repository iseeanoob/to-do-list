const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config");

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

function requireRank(minRank) {
  return (req, res, next) => {
    authenticateToken(req, res, () => {
      if (req.user.role < minRank)
        return res.status(403).json({ error: "Insufficient privileges." });
      next();
    });
  };
}

module.exports = { authenticateToken, requireRank };
