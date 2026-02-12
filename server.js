import express from "express"
import pg from "pg"
import path from "path"
import { fileURLToPath } from "url"
import { containsProfanity } from "./filter.js"
import rateLimit from "express-rate-limit"
import sanitizeHtml from "sanitize-html"
import fs from "fs"

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

const rssFeedCache = {
  global: { data: null, timestamp: 0 },
  users: new Map()
}
const RSS_CACHE_TTL = 5 * 60 * 1000

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function generateRSSFeed(posts, title, description, link) {
  const items = posts.map(post => {
    const postLink = `${link}/post/${post.id}`
    const pubDate = new Date(post.created_at).toUTCString()
    const content = escapeHtml(post.content)
    const author = escapeHtml(post.nickname)
    
    return `
    <item>
      <title>${author}: ${content.substring(0, 50)}${content.length > 50 ? '...' : ''}</title>
      <link>${postLink}</link>
      <description>${content}</description>
      <author>@${author}</author>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="true">${postLink}</guid>
    </item>`
  }).join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(title)}</title>
    <link>${link}</link>
    <description>${escapeHtml(description)}</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${link}/rss.xml" rel="self" type="application/rss+xml" />
    ${items}
  </channel>
</rss>`
}

function generateOGHtml(htmlPath, ogData) {
  let html = fs.readFileSync(path.join(__dirname, "public", htmlPath), 'utf8')
  
  const ogTags = `
<meta property="og:title" content="${escapeHtml(ogData.title)}">
<meta property="og:description" content="${escapeHtml(ogData.description)}">
<meta property="og:type" content="${ogData.type || 'website'}">
<meta property="og:url" content="${ogData.url}">
<meta property="og:site_name" content="txt">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(ogData.title)}">
<meta name="twitter:description" content="${escapeHtml(ogData.description)}">
`
  
  html = html.replace('</title>', `</title>${ogTags}`)
  return html
}

app.get("/", (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
  const html = generateOGHtml("landing.html", {
    title: "txt - a minimalist social network",
    description: "Join txt, a simple text-based social network",
    type: "website",
    url: baseUrl
  })
  res.send(html)
})

app.get("/feed", (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
  const html = generateOGHtml("index.html", {
    title: "txt feed",
    description: "Read the latest posts on txt",
    type: "website",
    url: `${baseUrl}/feed`
  })
  res.send(html)
})

app.get("/profile/:nick", async (req, res) => {
  try {
    const nick = req.params.nick.toLowerCase()
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
    
    const userResult = await pool.query("SELECT * FROM users WHERE nickname = $1", [nick])
    
    if (userResult.rows.length === 0) {
      return res.sendFile(path.join(__dirname, "public", "profile.html"))
    }
    
    const user = userResult.rows[0]
    const bio = user.bio || 'A txt user'
    
    const html = generateOGHtml("profile.html", {
      title: `@${nick} on txt`,
      description: bio,
      type: "profile",
      url: `${baseUrl}/profile/${nick}`
    })
    
    res.send(html)
  } catch (error) {
    res.sendFile(path.join(__dirname, "public", "profile.html"))
  }
})

app.get("/post/:id", async (req, res) => {
  try {
    const id = req.params.id
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
    
    const postResult = await pool.query(`
      SELECT p.*, COALESCE(SUM(r.value), 0) as score
      FROM posts p
      LEFT JOIN reactions r ON p.id = r.post_id
      WHERE p.id = $1
      GROUP BY p.id
    `, [id])
    
    if (postResult.rows.length === 0) {
      return res.sendFile(path.join(__dirname, "public", "post.html"))
    }
    
    const post = postResult.rows[0]
    const content = post.content.substring(0, 200)
    
    const html = generateOGHtml("post.html", {
      title: `@${post.nickname} on txt`,
      description: content,
      type: "article",
      url: `${baseUrl}/post/${id}`
    })
    
    res.send(html)
  } catch (error) {
    res.sendFile(path.join(__dirname, "public", "post.html"))
  }
})

app.get("/discover", (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
  const html = generateOGHtml("discover.html", {
    title: "discover - txt",
    description: "Find new people to follow on txt",
    type: "website",
    url: `${baseUrl}/discover`
  })
  res.send(html)
})

app.get("/notifications", (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
  const html = generateOGHtml("notifications.html", {
    title: "notifications - txt",
    description: "Your txt notifications",
    type: "website",
    url: `${baseUrl}/notifications`
  })
  res.send(html)
})

app.get("/profile/:nick/followers", (req, res) => {
  const nick = req.params.nick
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
  const html = generateOGHtml("followers.html", {
    title: `@${nick}'s followers - txt`,
    description: `People following @${nick} on txt`,
    type: "website",
    url: `${baseUrl}/profile/${nick}/followers`
  })
  res.send(html)
})

app.get("/profile/:nick/following", (req, res) => {
  const nick = req.params.nick
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
  const html = generateOGHtml("following.html", {
    title: `@${nick}'s following - txt`,
    description: `People @${nick} follows on txt`,
    type: "website",
    url: `${baseUrl}/profile/${nick}/following`
  })
  res.send(html)
})

app.get("/inbox", (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
  const html = generateOGHtml("inbox.html", {
    title: "inbox - txt",
    description: "Your txt inbox",
    type: "website",
    url: `${baseUrl}/inbox`
  })
  res.send(html)
})

app.get("/compose", (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
  const html = generateOGHtml("compose.html", {
    title: "compose message - txt",
    description: "Send a message on txt",
    type: "website",
    url: `${baseUrl}/compose`
  })
  res.send(html)
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

app.get("/settings", (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
  const html = generateOGHtml("settings.html", {
    title: "settings - txt",
    description: "Manage your txt account settings",
    type: "website",
    url: `${baseUrl}/settings`
  })
  res.send(html)
})

app.get("/license", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "licenseview.html"))
})

app.get("/developers", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "developers.html"))
})

const pendingTokens = Object.create(null)

app.get("/verify-rng", async (req, res) => {
  const { token } = req.query
  if (!token) return res.status(400).send("Missing token")
  res.sendFile(path.join(__dirname, "public", "verify-rng.html"))
})

app.get("/rss.xml", async (req, res) => {
  try {
    const now = Date.now()
    
    if (rssFeedCache.global.data && (now - rssFeedCache.global.timestamp) < RSS_CACHE_TTL) {
      res.set('Content-Type', 'application/rss+xml')
      res.set('Cache-Control', 'public, max-age=300')
      return res.send(rssFeedCache.global.data)
    }
    
    const result = await pool.query(`
      SELECT p.id, p.nickname, p.content, p.created_at
      FROM posts p
      ORDER BY p.created_at DESC
      LIMIT 50
    `)
    
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
    const rssXml = generateRSSFeed(
      result.rows,
      'txt - global feed',
      'Latest posts from txt social network',
      baseUrl
    )
    
    rssFeedCache.global = { data: rssXml, timestamp: now }
    
    res.set('Content-Type', 'application/rss+xml')
    res.set('Cache-Control', 'public, max-age=300')
    res.send(rssXml)
    
  } catch (error) {
    console.error('RSS feed error:', error)
    res.status(500).send('Error generating RSS feed')
  }
})

app.get("/rss/:nickname.xml", async (req, res) => {
  try {
    const nickname = req.params.nickname.toLowerCase()
    const now = Date.now()
    
    const cachedFeed = rssFeedCache.users.get(nickname)
    if (cachedFeed && (now - cachedFeed.timestamp) < RSS_CACHE_TTL) {
      res.set('Content-Type', 'application/rss+xml')
      res.set('Cache-Control', 'public, max-age=300')
      return res.send(cachedFeed.data)
    }
    
    const userCheck = await pool.query(
      "SELECT nickname FROM users WHERE nickname = $1",
      [nickname]
    )
    
    if (userCheck.rows.length === 0) {
      return res.status(404).send('User not found')
    }
    
    const result = await pool.query(`
      SELECT p.id, p.nickname, p.content, p.created_at
      FROM posts p
      WHERE p.nickname = $1
      ORDER BY p.created_at DESC
      LIMIT 50
    `, [nickname])
    
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`
    const rssXml = generateRSSFeed(
      result.rows,
      `txt - @${nickname}'s posts`,
      `Latest posts from @${nickname} on txt`,
      `${baseUrl}/profile/${nickname}`
    )
    
    rssFeedCache.users.set(nickname, { data: rssXml, timestamp: now })
    
    if (rssFeedCache.users.size > 100) {
      const firstKey = rssFeedCache.users.keys().next().value
      rssFeedCache.users.delete(firstKey)
    }
    
    res.set('Content-Type', 'application/rss+xml')
    res.set('Cache-Control', 'public, max-age=300')
    res.send(rssXml)
    
  } catch (error) {
    console.error('RSS feed error:', error)
    res.status(500).send('Error generating RSS feed')
  }
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

    CREATE TABLE IF NOT EXISTS rng_tokens (
    token TEXT PRIMARY KEY,
    created_at BIGINT
  );

    CREATE TABLE IF NOT EXISTS follows (
      follower TEXT,
      following TEXT,
      created_at BIGINT,
      PRIMARY KEY (follower, following)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_nick TEXT,
      type TEXT,
      from_user TEXT,
      post_id INTEGER,
      created_at BIGINT,
      read BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS reposts (
      id SERIAL PRIMARY KEY,
      nickname TEXT,
      original_post_id INTEGER,
      comment TEXT,
      created_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS fact_checks (
      id SERIAL PRIMARY KEY,
      post_id INTEGER UNIQUE,
      admin_message TEXT,
      created_at BIGINT,
      updated_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS user_activity (
      nickname TEXT PRIMARY KEY,
      activity_type TEXT,
      title TEXT,
      url TEXT,
      platform TEXT,
      timestamp BIGINT
    );

    CREATE TABLE IF NOT EXISTS guestbook (
      id SERIAL PRIMARY KEY,
      user_nick TEXT,
      author_nick TEXT,
      message TEXT,
      media_url TEXT,
      media_type TEXT,
      created_at BIGINT
    );
    
    CREATE INDEX IF NOT EXISTS idx_guestbook_user ON guestbook(user_nick);

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
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='guestbook_enabled') THEN
          ALTER TABLE users ADD COLUMN guestbook_enabled BOOLEAN DEFAULT FALSE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='guestbook_color') THEN
        ALTER TABLE users ADD COLUMN guestbook_color TEXT DEFAULT '#4c4';
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

async function createNotification(userNick, type, fromUser, postId = null) {
  await pool.query(
    "INSERT INTO notifications(user_nick, type, from_user, post_id, created_at) VALUES($1, $2, $3, $4, $5)",
    [userNick, type, fromUser, postId, Date.now()]
  )
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
  const feedType = req.query.feed || 'all'
  const nickname = req.query.nickname
  const now = Date.now()
  
  let query = `
    SELECT p.*, COALESCE(SUM(r.value), 0) as score
    FROM posts p
    LEFT JOIN reactions r ON p.id = r.post_id
  `
  
  if (feedType === 'following' && nickname) {
    query += `
      WHERE p.nickname IN (
        SELECT following FROM follows WHERE follower = $1
      )
    `
  }
  
  query += `
    GROUP BY p.id
    ORDER BY p.created_at DESC
    LIMIT 200
  `
  
  const result = feedType === 'following' && nickname 
    ? await pool.query(query, [nickname])
    : await pool.query(query)
  
  const posts = result.rows.slice(offset, offset + 20)
  const ids = posts.map(p => p.id)
  
  let comments = []
  let factChecks = []
  let reposts = []
  
  if (ids.length) {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')  
    
    const commentsResult = await pool.query(
      `SELECT * FROM comments WHERE post_id IN (${placeholders}) ORDER BY created_at ASC`,
      ids
    )
    comments = commentsResult.rows
    
    const factCheckResult = await pool.query(
      `SELECT * FROM fact_checks WHERE post_id IN (${placeholders})`,
      ids
    )
    factChecks = factCheckResult.rows
    
    const repostResult = await pool.query(
      `SELECT COUNT(*) as count, original_post_id FROM reposts WHERE original_post_id IN (${placeholders}) GROUP BY original_post_id`,
      ids
    )
    reposts = repostResult.rows
  }
  
  res.json({ posts, comments, factChecks, reposts })
})

app.get("/api/post/:id", async (req, res) => {
  const id = req.params.id
  
  const postResult = await pool.query(`
    SELECT p.*, COALESCE(SUM(r.value), 0) as score
    FROM posts p
    LEFT JOIN reactions r ON p.id = r.post_id
    WHERE p.id = $1
    GROUP BY p.id
  `, [id])
  
  if (postResult.rows.length === 0) return res.sendStatus(404)
  
  const commentsResult = await pool.query(
    "SELECT * FROM comments WHERE post_id = $1 ORDER BY created_at ASC",
    [id]
  )
  
  const factCheckResult = await pool.query(
    "SELECT * FROM fact_checks WHERE post_id = $1",
    [id]
  )
  
  const repostResult = await pool.query(
    "SELECT COUNT(*) as count FROM reposts WHERE original_post_id = $1",
    [id]
  )
  
  res.json({
    post: postResult.rows[0],
    comments: commentsResult.rows,
    factCheck: factCheckResult.rows[0] || null,
    repostCount: repostResult.rows[0].count
  })
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
  
  rssFeedCache.global.timestamp = 0
  rssFeedCache.users.delete(nickname.toLowerCase())
  
  const mentions = sanitized.match(/@(\w+)/g)
  if (mentions) {
    for (const mention of mentions) {
      const mentionedUser = mention.substring(1).toLowerCase()
      if (mentionedUser !== nickname) {
        await createNotification(mentionedUser, 'mention', nickname, result.rows[0].id)
      }
    }
  }
  
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
  
  const postResult = await pool.query("SELECT nickname FROM posts WHERE id = $1", [post_id])
  if (postResult.rows.length > 0 && postResult.rows[0].nickname !== nickname) {
    await createNotification(postResult.rows[0].nickname, 'reply', nickname, post_id)
  }
  
  const mentions = sanitized.match(/@(\w+)/g)
  if (mentions) {
    for (const mention of mentions) {
      const mentionedUser = mention.substring(1).toLowerCase()
      if (mentionedUser !== nickname) {
        await createNotification(mentionedUser, 'mention', nickname, post_id)
      }
    }
  }
  
  res.json({ id: result.rows[0].id })
})

app.post("/api/follow", async (req, res) => {
  const { follower, following } = req.body
  if (!follower || !following || follower === following) return res.sendStatus(400)
  
  const ban = await checkBan(follower)
  if (ban) return res.status(403).json({ banned: true })
  
  try {
    await pool.query(
      "INSERT INTO follows VALUES($1, $2, $3)",
      [follower.toLowerCase(), following.toLowerCase(), Date.now()]
    )
    await createNotification(following.toLowerCase(), 'follow', follower.toLowerCase())
    res.sendStatus(200)
  } catch {
    res.sendStatus(409)
  }
})

app.delete("/api/follow/:nickname", async (req, res) => {
  const { follower } = req.body
  const following = req.params.nickname
  
  await pool.query(
    "DELETE FROM follows WHERE follower = $1 AND following = $2",
    [follower.toLowerCase(), following.toLowerCase()]
  )
  res.sendStatus(200)
})

app.get("/api/followers/:nickname", async (req, res) => {
  const nickname = req.params.nickname.toLowerCase()
  const result = await pool.query(
    "SELECT follower, created_at FROM follows WHERE following = $1 ORDER BY created_at DESC",
    [nickname]
  )
  res.json({ followers: result.rows })
})

app.get("/api/following/:nickname", async (req, res) => {
  const nickname = req.params.nickname.toLowerCase()
  const result = await pool.query(
    "SELECT following, created_at FROM follows WHERE follower = $1 ORDER BY created_at DESC",
    [nickname]
  )
  res.json({ following: result.rows })
})

app.get("/api/is-following", async (req, res) => {
  const { follower, following } = req.query
  const result = await pool.query(
    "SELECT * FROM follows WHERE follower = $1 AND following = $2",
    [follower.toLowerCase(), following.toLowerCase()]
  )
  res.json({ isFollowing: result.rows.length > 0 })
})

app.get("/api/discover/users", async (req, res) => {
  const nickname = req.query.nickname
  const limit = Number(req.query.limit || 20)
  
  let query = `
    SELECT u.nickname, u.created_at, u.bio, 
           COUNT(DISTINCT f.follower) as follower_count,
           COUNT(DISTINCT p.id) as post_count
    FROM users u
    LEFT JOIN follows f ON u.nickname = f.following
    LEFT JOIN posts p ON u.nickname = p.nickname
  `
  
  if (nickname) {
    query += `
      WHERE u.nickname != $1 
      AND u.nickname NOT IN (
        SELECT following FROM follows WHERE follower = $1
      )
    `
  }
  
  query += `
    GROUP BY u.nickname, u.created_at, u.bio
    ORDER BY follower_count DESC, post_count DESC
    LIMIT $${nickname ? 2 : 1}
  `
  
  const result = nickname 
    ? await pool.query(query, [nickname.toLowerCase(), limit])
    : await pool.query(query, [limit])
  
  res.json({ users: result.rows })
})

app.get("/api/notifications/:nickname", async (req, res) => {
  const nickname = req.params.nickname.toLowerCase()
  const result = await pool.query(
    "SELECT * FROM notifications WHERE user_nick = $1 ORDER BY created_at DESC LIMIT 50",
    [nickname]
  )
  res.json({ notifications: result.rows })
})

app.get("/api/notifications/unread/:nickname", async (req, res) => {
  const nickname = req.params.nickname.toLowerCase()
  const result = await pool.query(
    "SELECT COUNT(*) as c FROM notifications WHERE user_nick = $1 AND read = FALSE",
    [nickname]
  )
  res.json({ count: result.rows[0].c })
})

app.get("/api/guestbook/:nickname", async (req, res) => {
  const nickname = req.params.nickname.toLowerCase()
  const result = await pool.query(
    "SELECT * FROM guestbook WHERE user_nick = $1 ORDER BY created_at DESC LIMIT 50",
    [nickname]
  )
  res.json({ entries: result.rows })
})

app.post("/api/guestbook", postLimiter, async (req, res) => {
  const { user_nick, author_nick, message, media_url, media_type } = req.body
  
  if (!user_nick || !author_nick) return res.sendStatus(400)
  if (message && message.length > 500) return res.sendStatus(400)
  
  const ban = await checkBan(author_nick)
  if (ban) return res.status(403).json({ banned: true })
  
  const userCheck = await pool.query(
    "SELECT guestbook_enabled FROM users WHERE nickname = $1",
    [user_nick.toLowerCase()]
  )
  
  if (userCheck.rows.length === 0 || !userCheck.rows[0].guestbook_enabled) {
    return res.status(403).json({ error: "guestbook disabled" })
  }
  
  const sanitizedMessage = message ? sanitizeHtml(message, { allowedTags: [], allowedAttributes: {} }) : null
  
  await pool.query(
    "INSERT INTO guestbook(user_nick, author_nick, message, media_url, media_type, created_at) VALUES($1, $2, $3, $4, $5, $6)",
    [user_nick.toLowerCase(), author_nick.toLowerCase(), sanitizedMessage, media_url, media_type, Date.now()]
  )
  
  if (user_nick.toLowerCase() !== author_nick.toLowerCase()) {
    await createNotification(user_nick.toLowerCase(), 'guestbook', author_nick.toLowerCase())
  }
  
  res.sendStatus(200)
})

app.delete("/api/guestbook/:id", async (req, res) => {
  const id = req.params.id
  const { nickname } = req.body
  
  const entry = await pool.query("SELECT user_nick FROM guestbook WHERE id = $1", [id])
  if (entry.rows.length === 0) return res.sendStatus(404)
  
  if (entry.rows[0].user_nick !== nickname.toLowerCase()) {
    return res.sendStatus(403)
  }
  
  await pool.query("DELETE FROM guestbook WHERE id = $1", [id])
  res.sendStatus(200)
})

app.post("/api/notifications/read/:id", async (req, res) => {
  const id = req.params.id
  await pool.query("UPDATE notifications SET read = TRUE WHERE id = $1", [id])
  res.sendStatus(200)
})

app.post("/api/notifications/read-all/:nickname", async (req, res) => {
  const nickname = req.params.nickname.toLowerCase()
  await pool.query("UPDATE notifications SET read = TRUE WHERE user_nick = $1", [nickname])
  res.sendStatus(200)
})

app.post("/api/repost", postLimiter, async (req, res) => {
  const { nickname, post_id, comment } = req.body
  if (!post_id) return res.sendStatus(400)
  if (comment && comment.length > 200) return res.sendStatus(400)
  
  const ban = await checkBan(nickname)
  if (ban) return res.status(403).json({ banned: true })
  
  const sanitizedComment = comment ? sanitizeHtml(comment, { allowedTags: [], allowedAttributes: {} }) : null
  
  const result = await pool.query(
    "INSERT INTO reposts(nickname, original_post_id, comment, created_at) VALUES($1, $2, $3, $4) RETURNING id",
    [nickname, post_id, sanitizedComment, Date.now()]
  )
  
  const postResult = await pool.query("SELECT nickname FROM posts WHERE id = $1", [post_id])
  if (postResult.rows.length > 0 && postResult.rows[0].nickname !== nickname) {
    await createNotification(postResult.rows[0].nickname, 'repost', nickname, post_id)
  }
  
  res.json({ id: result.rows[0].id })
})

app.delete("/api/repost/:id", async (req, res) => {
  const id = req.params.id
  const { nickname } = req.body
  
  await pool.query(
    "DELETE FROM reposts WHERE id = $1 AND nickname = $2",
    [id, nickname]
  )
  res.sendStatus(200)
})

app.get("/api/reposts/:post_id", async (req, res) => {
  const postId = req.params.post_id
  const result = await pool.query(
    "SELECT * FROM reposts WHERE original_post_id = $1 ORDER BY created_at DESC",
    [postId]
  )
  res.json({ reposts: result.rows })
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
  
  const followersResult = await pool.query(
    "SELECT COUNT(*) as c FROM follows WHERE following = $1",
    [nick]
  )
  
  const followingResult = await pool.query(
    "SELECT COUNT(*) as c FROM follows WHERE follower = $1",
    [nick]
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
    rngLinked: userResult.rows[0].rng_linked || false,
    followers: followersResult.rows[0].c,
    following: followingResult.rows[0].c
  })
})

app.post("/api/profile/update", async (req, res) => {
  const { nickname, bio, status, timezone, pronouns, guestbook_enabled, guestbook_color } = req.body
  if (!nickname) return res.sendStatus(400)
  
  if (bio && bio.length > 200) return res.sendStatus(400)
  if (status && status.length > 50) return res.sendStatus(400)
  if (pronouns && pronouns.length > 50) return res.sendStatus(400)
  
  const sanitizedBio = bio ? sanitizeHtml(bio, { allowedTags: [], allowedAttributes: {} }) : ''
  const sanitizedStatus = status ? sanitizeHtml(status, { allowedTags: [], allowedAttributes: {} }) : ''
  const sanitizedPronouns = pronouns ? sanitizeHtml(pronouns, { allowedTags: [], allowedAttributes: {} }) : ''
  
  await pool.query(
    "UPDATE users SET bio = $1, status = $2, timezone = $3, pronouns = $4, guestbook_enabled = $5, guestbook_color = $6 WHERE nickname = $7",
    [sanitizedBio, sanitizedStatus, timezone || 'UTC', sanitizedPronouns, guestbook_enabled || false, guestbook_color || '#4c4', nickname.toLowerCase()]
  )
  
  res.sendStatus(200)
})

app.delete("/api/account/:nick", async (req, res) => {
  const nick = req.params.nick.toLowerCase()
  
  try {
    await pool.query("DELETE FROM reactions WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM comments WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM posts WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM follows WHERE follower = $1 OR following = $1", [nick])
    await pool.query("DELETE FROM notifications WHERE user_nick = $1 OR from_user = $1", [nick])
    await pool.query("DELETE FROM reposts WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM user_activity WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM users WHERE nickname = $1", [nick])
    
    rssFeedCache.users.delete(nick)
    
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

app.get("/api/fact-check/:post_id", async (req, res) => {
  const postId = req.params.post_id
  const result = await pool.query(
    "SELECT * FROM fact_checks WHERE post_id = $1",
    [postId]
  )
  if (result.rows.length === 0) {
    return res.json({ factCheck: null })
  }
  res.json({ factCheck: result.rows[0] })
})

app.post("/api/admin/fact-check", async (req, res) => {
  const { post_id, admin_message } = req.body
  if (!post_id || !admin_message) return res.sendStatus(400)
  if (admin_message.length > 500) return res.sendStatus(400)
  
  const sanitized = sanitizeHtml(admin_message, { allowedTags: [], allowedAttributes: {} })
  
  const existing = await pool.query(
    "SELECT * FROM fact_checks WHERE post_id = $1",
    [post_id]
  )
  
  if (existing.rows.length > 0) {
    await pool.query(
      "UPDATE fact_checks SET admin_message = $1, updated_at = $2 WHERE post_id = $3",
      [sanitized, Date.now(), post_id]
    )
  } else {
    await pool.query(
      "INSERT INTO fact_checks(post_id, admin_message, created_at, updated_at) VALUES($1, $2, $3, $4)",
      [post_id, sanitized, Date.now(), Date.now()]
    )
  }
  
  res.sendStatus(200)
})

app.delete("/api/admin/fact-check/:post_id", async (req, res) => {
  const postId = req.params.post_id
  await pool.query("DELETE FROM fact_checks WHERE post_id = $1", [postId])
  res.sendStatus(200)
})

app.delete("/api/admin/post/:id", async (req, res) => {
  const id = req.params.id
  await pool.query("DELETE FROM comments WHERE post_id = $1", [id])
  await pool.query("DELETE FROM reactions WHERE post_id = $1", [id])
  await pool.query("DELETE FROM reposts WHERE original_post_id = $1", [id])
  await pool.query("DELETE FROM posts WHERE id = $1", [id])
  
  rssFeedCache.global.timestamp = 0
  
  res.sendStatus(200)
})

app.delete("/api/admin/account/:nick", async (req, res) => {
  const nick = req.params.nick.toLowerCase()
  try {
    await pool.query("DELETE FROM reactions WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM comments WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM posts WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM follows WHERE follower = $1 OR following = $1", [nick])
    await pool.query("DELETE FROM notifications WHERE user_nick = $1 OR from_user = $1", [nick])
    await pool.query("DELETE FROM reposts WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM user_activity WHERE nickname = $1", [nick])
    await pool.query("DELETE FROM users WHERE nickname = $1", [nick])
    
    rssFeedCache.global.timestamp = 0
    rssFeedCache.users.delete(nick)
    
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

app.post("/api/rng-create-token", async (req, res) => {
  const { token } = req.body
  
  if (!token || token.length < 10) {
    return res.status(400).json({ error: "Invalid token" })
  }
  
  await pool.query(
    "INSERT INTO rng_tokens(token, created_at) VALUES($1, $2)",
    [token, Date.now()]
  )
  
  res.json({ success: true })
})

app.post("/api/rng-link", async (req, res) => {
  const { nickname, token } = req.body

  if (!nickname || !token) {
    return res.status(400).json({ error: "Missing data" })
  }

  if (token.length < 10) {
    return res.status(400).json({ error: "Invalid token format" })
  }

  try {
    const userCheck = await pool.query(
      "SELECT nickname FROM users WHERE nickname = $1",
      [nickname.toLowerCase()]
    )

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found" })
    }

    await pool.query(
      "INSERT INTO rng_tokens(token, created_at) VALUES($1, $2) ON CONFLICT (token) DO NOTHING",
      [token, Date.now()]
    )

    const update = await pool.query(
      "UPDATE users SET rng_linked = TRUE WHERE nickname = $1 RETURNING nickname",
      [nickname.toLowerCase()]
    )

    await pool.query(
      "DELETE FROM rng_tokens WHERE token = $1",
      [token]
    )

    res.json({ success: true })
    
  } catch(error) {
    console.error("RNG link error:", error)
    res.status(500).json({ error: "Server error" })
  }
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

app.post("/api/activity", async (req, res) => {
  const nickname = req.body.nickname
  if (!nickname) return res.sendStatus(401)
  
  const userCheck = await pool.query("SELECT nickname FROM users WHERE nickname = $1", [nickname.toLowerCase()])
  if (userCheck.rows.length === 0) return res.sendStatus(401)
  
  const ban = await checkBan(nickname.toLowerCase())
  if (ban) return res.status(403).json({ banned: true })
  
  const activity = req.body
  
  await pool.query(
    `INSERT INTO user_activity(nickname, activity_type, title, url, platform, timestamp) 
     VALUES($1, $2, $3, $4, $5, $6)
     ON CONFLICT (nickname) DO UPDATE 
     SET activity_type = $2, title = $3, url = $4, platform = $5, timestamp = $6`,
    [
      nickname.toLowerCase(),
      activity.type || 'browsing',
      activity.title || null,
      activity.url || null,
      activity.mediaInfo?.platform || null,
      Date.now()
    ]
  )
  
  res.sendStatus(200)
})

app.get("/api/activity/:nickname", async (req, res) => {
  const nickname = req.params.nickname.toLowerCase()
  
  const result = await pool.query(
    "SELECT * FROM user_activity WHERE nickname = $1 AND timestamp > $2",
    [nickname, Date.now() - 30000]
  )
  
  if (result.rows.length === 0) {
    return res.json({ status: 'offline' })
  }
  
  res.json(result.rows[0])
})

app.listen(PORT, () => {
  console.log(`server running on port ${PORT}`)
})
