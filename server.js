import express from "express"
import Database from "better-sqlite3"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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
  parent_id INTEGER DEFAULT NULL,
  nickname TEXT,
  content TEXT,
  created_at INTEGER
);
`)

const postCache = { data: [], timestamp: 0 }

app.post("/api/nickname",(req,res)=>{
  const nickname=req.body.nickname?.trim().toLowerCase()
  if(!nickname || nickname.length>15) return res.sendStatus(400)
  try{
    db.prepare("INSERT INTO users VALUES (?,?)").run(nickname, Date.now())
    res.sendStatus(200)
  }catch{
    res.sendStatus(409)
  }
})

app.get("/api/posts",(req,res)=>{
  const offset = Number(req.query.offset || 0)
  const now = Date.now()
  if(now - postCache.timestamp > 5000){
    const posts = db.prepare(`
      SELECT p.*, IFNULL(SUM(r.value),0) score
      FROM posts p
      LEFT JOIN reactions r ON p.id=r.post_id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `).all()
    postCache.data = posts
    postCache.timestamp = now
  }
  const posts = postCache.data.slice(offset, offset+20)
  const ids = posts.map(p=>p.id)
  const comments = ids.length
    ? db.prepare(`SELECT * FROM comments WHERE post_id IN (${ids.map(()=>"?").join(",")}) ORDER BY created_at ASC`).all(...ids)
    : []
  res.json({ posts, comments })
})

app.post("/api/posts",(req,res)=>{
  const { nickname, content } = req.body
  if(!content || content.length>200) return res.sendStatus(400)
  const r = db.prepare("INSERT INTO posts(nickname,content,created_at) VALUES(?,?,?)").run(nickname, content, Date.now())
  res.json({id: r.lastInsertRowid})
})

app.post("/api/react",(req,res)=>{
  const { nickname, post_id, value } = req.body
  if(![1,-1].includes(value)) return res.sendStatus(400)
  db.prepare("INSERT OR REPLACE INTO reactions VALUES(?,?,?)").run(post_id,nickname,value)
  const score = db.prepare("SELECT IFNULL(SUM(value),0) c FROM reactions WHERE post_id=?").get(post_id).c
  res.json({score})
})

app.post("/api/comments",(req,res)=>{
  const { nickname, post_id, content, parent_id } = req.body
  if(!content || content.length>100) return res.sendStatus(400)
  const r = db.prepare("INSERT INTO comments(post_id,parent_id,nickname,content,created_at) VALUES(?,?,?,?,?)").run(post_id,parent_id||null,nickname,content,Date.now())
  res.json({id:r.lastInsertRowid})
})

app.get("/api/profile/:nick",(req,res)=>{
  const nick = req.params.nick.toLowerCase()
  const user = db.prepare("SELECT * FROM users WHERE nickname=?").get(nick)
  if(!user) return res.sendStatus(404)
  const posts = db.prepare("SELECT COUNT(*) c FROM posts WHERE nickname=?").get(nick).c
  const comments = db.prepare("SELECT COUNT(*) c FROM comments WHERE nickname=?").get(nick).c
  res.json({nickname:nick, created_at:user.created_at, posts, comments})
})

app.get("/profile.html/:nick",(req,res)=>{
  res.sendFile(path.join(__dirname,"public","profile.html"))
})

app.listen(PORT)
