const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || "change_this_secret_in_production";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
const sign = (u) => jwt.sign({ id: u.id, username: u.username }, SECRET, { expiresIn: "7d" });

function readToken(req) {
  try {
    return jwt.verify((req.headers.authorization || "").replace("Bearer ", ""), SECRET);
  } catch {
    return null;
  }
}
function auth(req, res, next) {
  const user = readToken(req);
  if (!user) return res.status(401).json({ error: "Please log in to continue." });
  req.user = user;
  next();
}
function optionalAuth(req, _res, next) {
  req.user = readToken(req);
  next();
}

// ---------- auth ----------
app.post("/api/register", (req, res) => {
  const username = (req.body.username || "").trim();
  const password = req.body.password || "";
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: "Username must be 3-20 letters, numbers or underscores." });
  if (password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  try {
    const info = db
      .prepare("INSERT INTO users (username, password) VALUES (?,?)")
      .run(username, bcrypt.hashSync(password, 10));
    const user = { id: info.lastInsertRowid, username };
    res.json({ token: sign(user), user });
  } catch {
    res.status(409).json({ error: "That username is taken." });
  }
});

app.post("/api/login", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get((req.body.username || "").trim());
  if (!user || !bcrypt.compareSync(req.body.password || "", user.password))
    return res.status(401).json({ error: "Wrong username or password." });
  res.json({ token: sign(user), user: { id: user.id, username: user.username } });
});

// ---------- profiles ----------
app.get("/api/users/:id", optionalAuth, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT id, username, bio, created_at FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "User not found." });
  const count = (sql) => db.prepare(sql).get(id).c;
  res.json({
    ...user,
    followers: count("SELECT COUNT(*) c FROM follows WHERE following_id = ?"),
    following: count("SELECT COUNT(*) c FROM follows WHERE follower_id = ?"),
    posts: count("SELECT COUNT(*) c FROM posts WHERE user_id = ?"),
    isFollowing: req.user
      ? !!db.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?").get(req.user.id, id)
      : false,
  });
});

app.put("/api/me", auth, (req, res) => {
  const bio = (req.body.bio || "").trim().slice(0, 160);
  db.prepare("UPDATE users SET bio = ? WHERE id = ?").run(bio, req.user.id);
  res.json({ bio });
});

app.get("/api/users", (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  res.json(db.prepare("SELECT id, username, bio FROM users WHERE username LIKE ? LIMIT 10").all(`%${q}%`));
});

// people you don't follow yet
app.get("/api/suggestions", auth, (req, res) => {
  res.json(
    db
      .prepare(`SELECT id, username, bio FROM users
                WHERE id != ? AND id NOT IN (SELECT following_id FROM follows WHERE follower_id = ?)
                ORDER BY id DESC LIMIT 5`)
      .all(req.user.id, req.user.id)
  );
});

app.post("/api/users/:id/follow", auth, (req, res) => {
  const target = Number(req.params.id);
  if (target === req.user.id) return res.status(400).json({ error: "You can't follow yourself." });
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(target))
    return res.status(404).json({ error: "User not found." });
  const removed = db
    .prepare("DELETE FROM follows WHERE follower_id = ? AND following_id = ?")
    .run(req.user.id, target);
  if (!removed.changes)
    db.prepare("INSERT INTO follows (follower_id, following_id) VALUES (?,?)").run(req.user.id, target);
  res.json({ following: !removed.changes });
});

// ---------- posts ----------
// ?feed=following  -> only people you follow (and you)
// ?user=ID         -> posts of one profile
app.get("/api/posts", optionalAuth, (req, res) => {
  const me = req.user ? req.user.id : 0;
  let where = "1=1";
  const params = [me];
  if (req.query.user) {
    where = "p.user_id = ?";
    params.push(Number(req.query.user));
  } else if (req.query.feed === "following" && me) {
    where = "(p.user_id = ? OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?))";
    params.push(me, me);
  }
  const rows = db
    .prepare(`
      SELECT p.id, p.user_id, p.content, p.created_at, u.username,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments,
        EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
      FROM posts p JOIN users u ON u.id = p.user_id
      WHERE ${where}
      ORDER BY p.id DESC LIMIT 100`)
    .all(...params);
  res.json(rows.map((r) => ({ ...r, liked: !!r.liked })));
});

app.post("/api/posts", auth, (req, res) => {
  const content = (req.body.content || "").trim();
  if (!content) return res.status(400).json({ error: "Write something before posting." });
  if (content.length > 280) return res.status(400).json({ error: "Posts can be up to 280 characters." });
  const info = db.prepare("INSERT INTO posts (user_id, content) VALUES (?,?)").run(req.user.id, content);
  res.json({ id: info.lastInsertRowid });
});

app.delete("/api/posts/:id", auth, (req, res) => {
  const info = db.prepare("DELETE FROM posts WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  if (!info.changes) return res.status(403).json({ error: "You can only delete your own posts." });
  res.json({ ok: true });
});

app.post("/api/posts/:id/like", auth, (req, res) => {
  if (!db.prepare("SELECT 1 FROM posts WHERE id = ?").get(req.params.id))
    return res.status(404).json({ error: "Post not found." });
  const removed = db
    .prepare("DELETE FROM likes WHERE post_id = ? AND user_id = ?")
    .run(req.params.id, req.user.id);
  if (!removed.changes)
    db.prepare("INSERT INTO likes (post_id, user_id) VALUES (?,?)").run(req.params.id, req.user.id);
  const likes = db.prepare("SELECT COUNT(*) c FROM likes WHERE post_id = ?").get(req.params.id).c;
  res.json({ liked: !removed.changes, likes });
});

// ---------- comments ----------
app.get("/api/posts/:id/comments", (req, res) => {
  res.json(
    db
      .prepare(`SELECT c.id, c.user_id, c.content, c.created_at, u.username
                FROM comments c JOIN users u ON u.id = c.user_id
                WHERE c.post_id = ? ORDER BY c.id`)
      .all(req.params.id)
  );
});

app.post("/api/posts/:id/comments", auth, (req, res) => {
  const content = (req.body.content || "").trim();
  if (!content) return res.status(400).json({ error: "Write a comment first." });
  if (content.length > 200) return res.status(400).json({ error: "Comments can be up to 200 characters." });
  if (!db.prepare("SELECT 1 FROM posts WHERE id = ?").get(req.params.id))
    return res.status(404).json({ error: "Post not found." });
  db.prepare("INSERT INTO comments (post_id, user_id, content) VALUES (?,?,?)").run(
    req.params.id, req.user.id, content
  );
  res.json({ ok: true });
});

app.delete("/api/comments/:id", auth, (req, res) => {
  const info = db.prepare("DELETE FROM comments WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  if (!info.changes) return res.status(403).json({ error: "You can only delete your own comments." });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Adda running at http://localhost:${PORT}`));
