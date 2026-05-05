const express = require("express");
const bodyParser = require("body-parser");

const { PORT } = require("./src/config");
const { connectWithRetry } = require("./src/db");
const authRouter = require("./src/routes/auth");
const usersRouter = require("./src/routes/users");
const todosRouter = require("./src/routes/todos");
const adminRouter = require("./src/routes/admin");
const teamTodosRouter = require("./src/routes/teamTodos");

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

app.get("/", (req, res) => res.send("🚀 Node + MySQL App Running"));

(async () => {
  const pool = await connectWithRetry();

  app.use(authRouter(pool));
  app.use(usersRouter(pool));
  app.use(todosRouter(pool));
  app.use(adminRouter(pool));
  app.use(teamTodosRouter(pool));

  app.listen(PORT, () =>
    console.log(`🚀 Server running on http://localhost:${PORT}`)
  );
})();
