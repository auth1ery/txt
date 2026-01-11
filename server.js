import express from "express"
import pg from "pg"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const PORT = process.env.PORT || 3000

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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

app.use(express.static("public"))

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      nickname TEXT PRIMARY KEY,
      created_at BIGINT
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
  `)
}

initDB().catch(console.error)

const postCache = { data: [], timestamp: 0 }

app.post("/api/nickname", async (req, res) => {
  const nickname = req.body.nickname?.trim().toLowerCase()
  if (!nickname || nickname.length > 15) return res.sendStatus(400)
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

app.post("/api/posts", async (req, res) => {
  const { nickname, content } = req.body
  if (!content || content.length > 200) return res.sendStatus(400)
  
  const result = await pool.query(
    "INSERT INTO posts(nickname, content, created_at) VALUES($1, $2, $3) RETURNING id",
    [nickname, content, Date.now()]
  )
  res.json({ id: result.rows[0].id })
})

app.post("/api/react", async (req, res) => {
  const { nickname, post_id, value } = req.body
  if (![1, -1].includes(value)) return res.sendStatus(400)
  
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

app.post("/api/comments", async (req, res) => {
  const { nickname, post_id, content, parent_id } = req.body
  if (!content || content.length > 100) return res.sendStatus(400)
  
  const result = await pool.query(
    "INSERT INTO comments(post_id, parent_id, nickname, content, created_at) VALUES($1, $2, $3, $4, $5) RETURNING id",
    [post_id, parent_id || null, nickname, content, Date.now()]
  )
  res.json({ id: result.rows[0].id })
})

app.get("/api/profile/:nick", async (req, res) => {
  const nick = req.params.nick.toLowerCase()
  
  const userResult = await pool.query("SELECT * FROM users WHERE nickname = $1", [nick])
  if (userResult.rows.length === 0) return res.sendStatus(404)
  
  const postsResult = await pool.query("SELECT COUNT(*) as c FROM posts WHERE nickname = $1", [nick])
  const commentsResult = await pool.query("SELECT COUNT(*) as c FROM comments WHERE nickname = $1", [nick])
  
  res.json({
    nickname: nick,
    created_at: userResult.rows[0].created_at,
    posts: postsResult.rows[0].c,
    comments: commentsResult.rows[0].c
  })
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

app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`)
})
