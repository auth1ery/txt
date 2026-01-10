import express from "express"
import Database from "better-sqlite3"

const app = express()
const db = new Database("db.sqlite")
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(express.static("public"))

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  nickname TEXT PRIMARY KEY,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT,
  content TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS reactions (
  post_id INTEGER,
  nickname TEXT,
  value INTEGER,
  PRIMARY KEY (post_id, nickname)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  nickname TEXT,
  content TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS rate_limits (
  nickname TEXT PRIMARY KEY,
  count INTEGER,
  window_start INTEGER
);
`)

function rateLimit(nickname) {
  const now = Date.now()
  const row = db.prepare("SELECT * FROM rate_limits WHERE nickname = ?").get(nickname)

  if (!row || now - row.window_start > 60000) {
    db.prepare("INSERT OR REPLACE INTO rate_limits VALUES (?, 1, ?)").run(nickname, now)
    return true
  }

  if (row.count >= 20) return false

  db.prepare("UPDATE rate_limits SET count = count + 1 WHERE nickname = ?").run(nickname)
  return true
}

app.post("/api/nickname", (req, res) => {
  const nickname = req.body.nickname?.trim().toLowerCase()
  if (!nickname || nickname.length > 15) return res.sendStatus(400)

  try {
    db.prepare("INSERT INTO users VALUES (?, ?)").run(nickname, Date.now())
    res.sendStatus(200)
  } catch {
    res.sendStatus(409)
  }
})

app.get("/api/posts", (req, res) => {
  const offset = Number(req.query.offset || 0)

  const posts = db.prepare(`
    SELECT p.*,
      IFNULL(SUM(r.value),0) score
    FROM posts p
    LEFT JOIN reactions r ON p.id = r.post_id
    GROUP BY p.id
    ORDER BY p.created_at DESC
    LIMIT 20 OFFSET ?
  `).all(offset)

  const ids = posts.map(p => p.id)
  const comments = ids.length
    ? db.prepare(`SELECT * FROM comments WHERE post_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at ASC`).all(...ids)
    : []

  res.json({ posts, comments })
})

app.post("/api/posts", (req, res) => {
  const { nickname, content } = req.body
  if (!rateLimit(nickname)) return res.sendStatus(429)
  if (!content || content.length > 200) return res.sendStatus(400)

  db.prepare("INSERT INTO posts (nickname, content, created_at) VALUES (?, ?, ?)").run(
    nickname,
    content,
    Date.now()
  )

  res.sendStatus(200)
})

app.post("/api/react", (req, res) => {
  const { nickname, post_id, value } = req.body
  if (!rateLimit(nickname)) return res.sendStatus(429)
  if (![1, -1].includes(value)) return res.sendStatus(400)

  db.prepare("INSERT OR REPLACE INTO reactions VALUES (?, ?, ?)").run(post_id, nickname, value)
  res.sendStatus(200)
})

app.post("/api/comments", (req, res) => {
  const { nickname, post_id, content } = req.body
  if (!rateLimit(nickname)) return res.sendStatus(429)
  if (!content || content.length > 100) return res.sendStatus(400)

  db.prepare("INSERT INTO comments (post_id, nickname, content, created_at) VALUES (?, ?, ?, ?)").run(
    post_id,
    nickname,
    content,
    Date.now()
  )

  res.sendStatus(200)
})

app.get("/api/profile/:nick", (req, res) => {
  const nick = req.params.nick.toLowerCase()

  const user = db.prepare("SELECT * FROM users WHERE nickname = ?").get(nick)
  if (!user) return res.sendStatus(404)

  const posts = db.prepare("SELECT COUNT(*) c FROM posts WHERE nickname = ?").get(nick).c
  const comments = db.prepare("SELECT COUNT(*) c FROM comments WHERE nickname = ?").get(nick).c

  res.json({
    nickname: nick,
    created_at: user.created_at,
    posts,
    comments
  })
})

const PORT = process.env.PORT || 3000
app.listen(PORT)
