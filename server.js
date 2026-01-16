import express from "express"
import pg from "pg"
import path from "path"
import { fileURLToPath } from "url"
import { containsProfanity } from "./filter.js"
import rateLimit from "express-rate-limit"
import sanitizeHtml from "sanitize-html"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
app.use(express.json())
const PORT = process.env.PORT || 3000

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK
const ADMIN_PASS = process.env.ADMIN_PASS

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many requests, slow down!" }
})

const postLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many posts, wait a minute!" }
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Too many login attempts, try again later" }
})

app.use(express.json())

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"))
})

app.get("/feed", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"))
})

app.get("/profile/:nick", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "profile.html"))
})

app.get("/terms", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "terms.html"))
})

app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"))
})

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"))
})

app.get("/banned", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "banned.html"))
})

app.get("/hell", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "hell.html"))
})

app.get("/inbox", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "inbox.html"))
})

app.get("/compose", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "compose.html"))
})

app.get("/settings", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "settings.html"))
})

app.get("/license", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "licenseview.html"))
})

app.get("/developers", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "developers.html"))
})

const pendingTokens = Object.create(null)

app.get("/verify-rng", (req, res) => {
  const { token } = req.query
  if (!token) return res.status(400).send("Missing token")

  pendingTokens[token] = {
    createdAt: Date.now()
  }

  res.sendFile(path.join(__dirname, "public", "verify-rng.html"))
})

app.use(express.static("public"))

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      nickname TEXT PRIMARY KEY,
      created_at BIGINT,
      bio TEXT DEFAULT '',
      status TEXT DEFAULT '',
      timezone TEXT DEFAULT 'UTC',
      pronouns TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      nickname TEXT,
      content TEXT,
      created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS reactions (
      post_id INTEGER,
      nickname TEXT,
      value INTEGER,
      PRIMARY KEY (post_id, nickname)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER,
      parent_id INTEGER DEFAULT NULL,
      nickname TEXT,
      content TEXT,
      created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      reporter TEXT,
      type TEXT,
      target_user TEXT,
      target_post INTEGER,
      reason TEXT,
      created_at BIGINT,
      status TEXT DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS bans (
      nickname TEXT PRIMARY KEY,
      reason TEXT,
      banned_until BIGINT,
      banned_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_user TEXT,
      to_user TEXT,
      subject TEXT,
      content TEXT,
      created_at BIGINT,
      read BOOLEAN DEFAULT FALSE,
      is_broadcast BOOLEAN DEFAULT FALSE
    );
    
    DO $$ 
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='bio') THEN
        ALTER TABLE users ADD COLUMN bio TEXT DEFAULT '';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='status') THEN
        ALTER TABLE users ADD COLUMN status TEXT DEFAULT '';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='timezone') THEN
        ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'UTC';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='pronouns') THEN
        ALTER TABLE users ADD COLUMN pronouns TEXT DEFAULT '';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='rng_linked') THEN
        ALTER TABLE users ADD COLUMN rng_linked BOOLEAN DEFAULT FALSE;
      END IF;
    END $$;
  `)
}

initDB().catch(console.error)

const postCache = { data: [], timestamp: 0 }

async function checkBan(nickname) {
  const result = await pool.query(
    "SELECT * FROM bans WHERE nickname = $1",
    [nickname]
  )
  if (result.rows.length === 0) return null
  const ban = result.rows[0]
  if (ban.banned_until !== -1 && Date.now() > ban.banned_until) {
    await pool.query("DELETE FROM bans WHERE nickname = $1", [nickname])
    return null
  }
  return ban
}

app.post("/api/check-ban", async (req, res) => {
  const { nickname } = req.body
  const ban = await checkBan(nickname)
  if (ban) {
    const timeLeft = ban.banned_until === -1 ? "forever" : 
      Math.ceil((ban.banned_until - Date.now()) / 1000 / 60 / 60 / 24) + " days"
    res.json({ banned: true, reason: ban.reason, timeLeft })
  } else {
    res.json({ banned: false })
  }
})

app.post("/api/nickname", async (req, res) => {
  const nickname = req.body.nickname?.trim().toLowerCase()
  if (!nickname || nickname.length > 15) return res.sendStatus(400)
  
  const sanitized = sanitizeHtml(nickname, { allowedTags: [], allowedAttributes: {} })
  if (sanitized !== nickname) return res.sendStatus(400)
  if (containsProfanity(nickname)) return res.sendStatus(400)
  
  const ban = await checkBan(nickname)
  if (ban) return res.status(403).json({ banned: true })
  
  try {
    await pool.query("INSERT INTO users VALUES ($1, $2)", [nickname, Date.now()])
    res.sendStatus(200)
  } catch {
    res.sendStatus(409)
  }
})

app.get("/api/usercount", async (req, res) => {
  const result = await pool.query("SELECT COUNT(*) as c FROM users")
  res.json({ count: result.rows[0].c })
})

app.get("/api/posts", async (req, res) => {
  const offset = Number(req.query.offset || 0)
  const now = Date.now()
  
  if (now - postCache.timestamp > 5000) {
    const result = await pool.query(`
      SELECT p.*, COALESCE(SUM(r.value), 0) as score
      FROM posts p
      LEFT JOIN reactions r ON p.id = r.post_id
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 200
    `)
    postCache.data = result.rows
    postCache.timestamp = now
  }
  
  const posts = postCache.data.slice(offset, offset + 20)
  const ids = posts.map(p => p.id)
  
  let comments = []
  if (ids.length) {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
    const result = await pool.query(
      `SELECT * FROM comments WHERE post_id IN (${placeholders}) ORDER BY created_at ASC`,
      ids
    )
    comments = result.rows
  }
  
  res.json({ posts, comments })
})

app.post("/api/posts", postLimiter, async (req, res) => {
  const { nickname, content } = req.body
  if (!content || content.length > 200) return res.sendStatus(400)
  
  const sanitized = sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} })
  if (containsProfanity(sanitized)) return res.sendStatus(400)
  
  const ban = await checkBan(nickname)
  if (ban) return res.status(403).json({ banned: true })
  
  const result = await pool.query(
    "INSERT INTO posts(nickname, content, created_at) VALUES($1, $2, $3) RETURNING id",
    [nickname, sanitized, Date.now()]
  )
  
  if (DISCORD_WEBHOOK) {
    try {
      await fetch(DISCORD_WEBHOOK, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: `**new post created:**\n\ncontent: ${sanitized}\nuploader: ${nickname}\nview on: https://txt-ctgm.onrender.com/`
        })
      })
    } catch (error) {
      console.error('Failed to send Discord webhook:', error)
    }
  }
  
  res.json({ id: result.rows[0].id })
})

app.post("/api/react", async (req, res) => {
  const { nickname, post_id, value } = req.body
  if (![1, -1].includes(value)) return res.sendStatus(400)
  
  const ban = await checkBan(nickname)
  if (ban) return res.status(403).json({ banned: true })
  
  await pool.query(
    `INSERT INTO reactions VALUES($1, $2, $3) 
     ON CONFLICT (post_id, nickname) DO UPDATE SET value = $3`,
    [post_id, nickname, value]
  )
  
  const result = await pool.query(
    "SELECT COALESCE(SUM(value), 0) as c FROM reactions WHERE post_id = $1",
    [post_id]
  )
  res.json({ score: result.rows[0].c })
})

app.post("/api/comments", postLimiter, async (req, res) => {
  const { nickname, post_id, content, parent_id } = req.body
  if (!content || content.length > 100) return res.sendStatus(400)
  
  const sanitized = sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} })
  if (containsProfanity(sanitized)) return res.sendStatus(400)
  
  const ban = await checkBan(nickname)
  if (ban) return res.status(403).json({ banned: true })
  
  const result = await pool.query(
    "INSERT INTO comments(post_id, parent_id, nickname, content, created_at) VALUES($1, $2, $3, $4, $5) RETURNING id",
    [post_id, parent_id || null, nickname, sanitized, Date.now()]
  )
  res.json({ id: result.rows[0].id })
})

app.get("/api/profile/:nick", async (req, res) => {
  const nick = req.params.nick.toLowerCase()
  
  const userResult = await pool.query("SELECT * FROM users WHERE nickname = $1", [nick])
  if (userResult.rows.length === 0) return res.sendStatus(404)
  
  const postsResult = await pool.query("SELECT COUNT(*) as c FROM posts WHERE nickname = $1", [nick])
  const commentsResult = await pool.query("SELECT COUNT(*) as c FROM comments WHERE nickname = $1", [nick])
  
  const joinNumberResult = await pool.query(
    "SELECT COUNT(*) as num FROM users WHERE created_at <= $1",
    [userResult.rows[0].created_at]
  )
  
  const reactionsResult = await pool.query(`
    SELECT 
      SUM(CASE WHEN r.value = 1 THEN 1 ELSE 0 END) as upvotes,
      SUM(CASE WHEN r.value = -1 THEN 1 ELSE 0 END) as downvotes
    FROM posts p
    LEFT JOIN reactions r ON p.id = r.post_id
    WHERE p.nickname = $1
  `, [nick])
  
  const upvotes = Number(reactionsResult.rows[0].upvotes) || 0
  const downvotes = Number(reactionsResult.rows[0].downvotes) || 0
  const total = upvotes + downvotes
  const controversyScore = total > 0 ? Math.round((upvotes / total) * 100) : 0
  
  const lastPostResult = await pool.query(
    "SELECT * FROM posts WHERE nickname = $1 ORDER BY created_at DESC LIMIT 1",
    [nick]
  )
  
  res.json({
    nickname: nick,
    created_at: userResult.rows[0].created_at,
    bio: userResult.rows[0].bio || '',
    status: userResult.rows[0].status || '',
    timezone: userResult.rows[0].timezone || 'UTC',
    pronouns: userResult.rows[0].pronouns || '',
    posts: postsResult.rows[0].c,
    comments: commentsResult.rows[0].c,
    joinNumber: joinNumberResult.rows[0].num,
    controversyScore,
    upvotes,
    downvotes,
    lastPost: lastPostResult.rows[0] || null,

    rngLinked: userResult.rows[0].rng_linked || false
  })
})

app.post("/api/profile/update", async (req, res) => {
  const { nickname, bio, status, timezone, pronouns } = req.body
  if (!nickname) return res.sendStatus(400)
  
  if (bio && bio.length > 200) return res.sendStatus(400)
  if (status && status.length > 50) return res.sendStatus(400)
  if (pronouns && pronouns.length > 50) return res.sendStatus(400)
  
  const sanitizedBio = bio ? sanitizeHtml(bio, { allowedTags: [], allowedAttributes: {} }) : ''
  const sanitizedStatus = status ? sanitizeHtml(status, { allowedTags: [], allowedAttributes: {} }) : ''
  const sanitizedPronouns = pronouns ? sanitizeHtml(pronouns, { allowedTags: [], allowedAttributes: {} }) : ''
  
  await pool.query(
    "UPDATE users SET bio = $1, status = $2, timezone = $3, pronouns = $4 WHERE nickname = $5",
    [sanitizedBio, sanitizedStatus, timezone || 'UTC', sanitizedPronouns, nickname.toLowerCase()]
  )
  
  res.sendStatus(200)
})

app.delete("/api/account/:nick", async (req, res) => {
  const nick = req.params.nick.toLowerCase()
  
  try {
    await pool.query("DELETE FROM reactions WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM comments WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM posts WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM users WHERE nickname = $1", [nick])
    
    res.sendStatus(200)
  } catch (error) {
    console.error(error)
    res.sendStatus(500)
  }
})

app.post("/api/report", async (req, res) => {
  const { reporter, type, target_user, target_post, reason } = req.body
  if (!reason || reason.length > 500) return res.sendStatus(400)
  
  const sanitized = sanitizeHtml(reason, { allowedTags: [], allowedAttributes: {} })
  
  await pool.query(
    "INSERT INTO reports(reporter, type, target_user, target_post, reason, created_at) VALUES($1, $2, $3, $4, $5, $6)",
    [reporter, type, target_user || null, target_post || null, sanitized, Date.now()]
  )
  
  res.sendStatus(200)
})

app.post("/api/admin/verify", authLimiter, async (req, res) => {
  const { password } = req.body
  if (password === ADMIN_PASS) {
    res.json({ valid: true })
  } else {
    res.json({ valid: false })
  }
})

app.get("/api/admin/reports", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM reports WHERE status = 'pending' ORDER BY created_at DESC"
  )
  res.json({ reports: result.rows })
})

app.get("/api/admin/posts", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM posts ORDER BY created_at DESC LIMIT 100"
  )
  res.json({ posts: result.rows })
})

app.get("/api/admin/users", async (req, res) => {
  const result = await pool.query("SELECT nickname, created_at FROM users ORDER BY created_at DESC")
  res.json({ users: result.rows })
})

app.post("/api/admin/ban", async (req, res) => {
  const { nickname, reason, duration } = req.body
  if (!nickname || !reason) return res.sendStatus(400)
  
  let banned_until = -1
  if (duration !== 'infinite') {
    const days = parseInt(duration)
    banned_until = Date.now() + (days * 24 * 60 * 60 * 1000)
  }
  
  await pool.query(
    "INSERT INTO bans VALUES($1, $2, $3, $4) ON CONFLICT (nickname) DO UPDATE SET reason = $2, banned_until = $3, banned_at = $4",
    [nickname, reason, banned_until, Date.now()]
  )
  
  res.sendStatus(200)
})

app.post("/api/admin/resolve-report", async (req, res) => {
  const { id } = req.body
  await pool.query("UPDATE reports SET status = 'resolved' WHERE id = $1", [id])
  res.sendStatus(200)
})

app.get("/api/admin/bans", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM bans ORDER BY banned_at DESC"
  )
  res.json({ bans: result.rows })
})

app.post("/api/admin/unban", async (req, res) => {
  const { nickname } = req.body
  if (!nickname) return res.sendStatus(400)
  
  await pool.query("DELETE FROM bans WHERE nickname = $1", [nickname])
  res.sendStatus(200)
})

app.delete("/api/admin/post/:id", async (req, res) => {
  const id = req.params.id
  await pool.query("DELETE FROM comments WHERE post_id = $1", [id])
  await pool.query("DELETE FROM reactions WHERE post_id = $1", [id])
  await pool.query("DELETE FROM posts WHERE id = $1", [id])
  res.sendStatus(200)
})

app.delete("/api/admin/account/:nick", async (req, res) => {
  const nick = req.params.nick.toLowerCase()
  try {
    await pool.query("DELETE FROM reactions WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM comments WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM posts WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM users WHERE nickname = $1", [nick])
    res.sendStatus(200)
  } catch (error) {
    console.error(error)
    res.sendStatus(500)
  }
})

app.get("/api/messages/:nickname", async (req, res) => {
  const nickname = req.params.nickname.toLowerCase()
  const result = await pool.query(
    "SELECT * FROM messages WHERE to_user = $1 ORDER BY created_at DESC",
    [nickname]
  )
  res.json({ messages: result.rows })
})

app.get("/api/messages/unread/:nickname", async (req, res) => {
  const nickname = req.params.nickname.toLowerCase()
  const result = await pool.query(
    "SELECT COUNT(*) as c FROM messages WHERE to_user = $1 AND read = FALSE",
    [nickname]
  )
  res.json({ count: result.rows[0].c })
})

app.post("/api/messages", postLimiter, async (req, res) => {
  const { from_user, to_user, subject, content } = req.body
  if (!to_user || !subject || !content) return res.sendStatus(400)
  if (subject.length > 100 || content.length > 500) return res.sendStatus(400)
  
  const sanitizedSubject = sanitizeHtml(subject, { allowedTags: [], allowedAttributes: {} })
  const sanitizedContent = sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} })
  
  const userExists = await pool.query("SELECT * FROM users WHERE nickname = $1", [to_user.toLowerCase()])
  if (userExists.rows.length === 0) return res.status(404).json({ error: "User not found" })
  
  await pool.query(
    "INSERT INTO messages(from_user, to_user, subject, content, created_at) VALUES($1, $2, $3, $4, $5)",
    [from_user, to_user.toLowerCase(), sanitizedSubject, sanitizedContent, Date.now()]
  )
  
  res.sendStatus(200)
})

app.post("/api/rng-link", async (req, res) => {
  const { nickname, token } = req.body

  if (!nickname || !token) {
    return res.status(400).json({ error: "Missing data" })
  }

  if (!pendingTokens[token]) {
    return res.status(400).json({ error: "Invalid or expired token" })
  }

  await pool.query(
    "UPDATE users SET rng_linked = TRUE WHERE nickname = $1",
    [nickname.toLowerCase()]
  )

  delete pendingTokens[token]

  res.sendStatus(200)
})

app.post("/api/messages/read/:id", async (req, res) => {
  const id = req.params.id
  await pool.query("UPDATE messages SET read = TRUE WHERE id = $1", [id])
  res.sendStatus(200)
})

app.post("/api/admin/broadcast", async (req, res) => {
  const { subject, content } = req.body
  if (!subject || !content) return res.sendStatus(400)
  if (subject.length > 100 || content.length > 500) return res.sendStatus(400)
  
  const sanitizedSubject = sanitizeHtml(subject, { allowedTags: [], allowedAttributes: {} })
  const sanitizedContent = sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} })
  
  const users = await pool.query("SELECT nickname FROM users")
  
  for (const user of users.rows) {
    await pool.query(
      "INSERT INTO messages(from_user, to_user, subject, content, created_at, is_broadcast) VALUES($1, $2, $3, $4, $5, $6)",
      ["admin", user.nickname, sanitizedSubject, sanitizedContent, Date.now(), true]
    )
  }
  
  res.sendStatus(200)
})

app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`)
})
