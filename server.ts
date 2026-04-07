import { Database } from "bun:sqlite";

// Initialize database
const db = new Database("./storage/moments.db");

// Create tables
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT,
    title TEXT,
    description TEXT,
    user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Create default admin user if not exists
const adminExists = db.query("SELECT id FROM users WHERE username = ?").get("admin");
if (!adminExists) {
  // Simple password hash (in production, use bcrypt)
  const passwordHash = await Bun.password.hash("family123", "argon2id");
  db.run("INSERT INTO users (username, password_hash) VALUES (?, ?)", ["admin", passwordHash]);
  console.log("Created default admin user: admin / family123");
}

// Session store (simple in-memory for single server)
const sessions = new Map<string, { userId: number; username: string }>();

// Helper: Generate session token
function generateToken(): string {
  return crypto.randomUUID();
}

// Helper: Verify session
function getSession(token: string): { userId: number; username: string } | null {
  return sessions.get(token) || null;
}

// Helper: Parse cookies
function parseCookies(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) return cookies;
  
  for (const cookie of cookieHeader.split(";")) {
    const [key, value] = cookie.trim().split("=");
    if (key && value) {
      cookies.set(key, value);
    }
  }
  return cookies;
}

// Helper: Check auth middleware
function checkAuth(req: Request): { userId: number; username: string } | null {
  const cookies = parseCookies(req.headers.get("Cookie"));
  const token = cookies.get("session");
  if (!token) return null;
  return getSession(token);
}

// Helper: Serve static file
async function serveStatic(path: string): Promise<Response | null> {
  const file = Bun.file(`./public${path}`);
  if (await file.exists()) {
    return new Response(file);
  }
  return null;
}

// Main server
const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    // CORS headers for API
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle OPTIONS for CORS
    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- PUBLIC ROUTES ---

    // GET / - Main page (redirect to login if not authenticated)
    if (path === "/" && method === "GET") {
      const user = checkAuth(req);
      if (!user) {
        return Response.redirect("/login", 302);
      }
      return serveStatic("/index.html") || new Response("Not found", { status: 404 });
    }

    // GET /login - Login page
    if (path === "/login" && method === "GET") {
      const user = checkAuth(req);
      if (user) {
        return Response.redirect("/", 302);
      }
      return serveStatic("/login.html") || new Response("Not found", { status: 404 });
    }

    // GET /upload - Upload page
    if (path === "/upload" && method === "GET") {
      const user = checkAuth(req);
      if (!user) {
        return Response.redirect("/login", 302);
      }
      return serveStatic("/upload.html") || new Response("Not found", { status: 404 });
    }

    // GET /style.css - Styles
    if (path === "/style.css" && method === "GET") {
      return serveStatic("/style.css") || new Response("Not found", { status: 404 });
    }

    // --- AUTH API ---

    // POST /api/login - Authenticate user
    if (path === "/api/login" && method === "POST") {
      try {
        const formData = await req.formData();
        const username = formData.get("username") as string;
        const password = formData.get("password") as string;

        if (!username || !password) {
          return new Response("Missing username or password", { status: 400 });
        }

        const user = db.query("SELECT * FROM users WHERE username = ?").get(username) as any;
        if (!user) {
          return new Response("Invalid credentials", { status: 401 });
        }

        const valid = await Bun.password.verify(password, user.password_hash, "argon2id");
        if (!valid) {
          return new Response("Invalid credentials", { status: 401 });
        }

        // Create session
        const token = generateToken();
        sessions.set(token, { userId: user.id, username: user.username });

        // Redirect to home with cookie
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/",
            "Set-Cookie": `session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`,
          },
        });
      } catch (error) {
        console.error("Login error:", error);
        return new Response("Server error", { status: 500 });
      }
    }

    // POST /api/logout - Logout user
    if (path === "/api/logout" && method === "POST") {
      const cookies = parseCookies(req.headers.get("Cookie"));
      const token = cookies.get("session");
      if (token) {
        sessions.delete(token);
      }
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/login",
          "Set-Cookie": "session=; HttpOnly; Path=/; Max-Age=0",
        },
      });
    }

    // --- VIDEO API ---

    // GET /api/videos - List all videos
    if (path === "/api/videos" && method === "GET") {
      const user = checkAuth(req);
      if (!user) {
        return new Response("Unauthorized", { status: 401 });
      }

      const videos = db.query(`
        SELECT v.*, u.username 
        FROM videos v 
        JOIN users u ON v.user_id = u.id 
        ORDER BY v.created_at DESC
      `).all();

      return Response.json(videos, { headers: corsHeaders });
    }

    // GET /videos/:id - Stream video file
    const videoMatch = path.match(/^\/videos\/(\d+)$/);
    if (videoMatch && method === "GET") {
      const user = checkAuth(req);
      if (!user) {
        return new Response("Unauthorized", { status: 401 });
      }

      const videoId = parseInt(videoMatch[1]);
      const video = db.query("SELECT * FROM videos WHERE id = ?").get(videoId) as any;

      if (!video) {
        return new Response("Video not found", { status: 404 });
      }

      const file = Bun.file(`./storage/videos/${video.filename}`);
      if (!(await file.exists())) {
        return new Response("Video file not found", { status: 404 });
      }

      // Support range requests for video streaming
      const range = req.headers.get("Range");
      if (range) {
        const fileSize = file.size;
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        const slice = file.slice(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize.toString(),
            "Content-Type": "video/mp4",
          },
        });
      }

      return new Response(file, {
        headers: {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
        },
      });
    }

    // POST /api/upload - Upload video
    if (path === "/api/upload" && method === "POST") {
      const user = checkAuth(req);
      if (!user) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const formData = await req.formData();
        const videoFile = formData.get("video") as File;
        const title = formData.get("title") as string || "";
        const description = formData.get("description") as string || "";

        if (!videoFile || videoFile.size === 0) {
          return new Response("No video file provided", { status: 400 });
        }

        // Generate unique filename
        const ext = videoFile.name.split(".").pop() || "mp4";
        const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`;
        
        // Save video file
        const buffer = await videoFile.arrayBuffer();
        await Bun.write(`./storage/videos/${filename}`, buffer);

        // Save to database
        const result = db.run(
          "INSERT INTO videos (filename, original_name, title, description, user_id) VALUES (?, ?, ?, ?, ?)",
          [filename, videoFile.name, title, description, user.userId]
        );

        console.log(`Uploaded video: ${filename} by ${user.username}`);

        return new Response(JSON.stringify({ 
          success: true, 
          id: result.lastInsertRowid,
          filename 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("Upload error:", error);
        return new Response("Upload failed", { status: 500 });
      }
    }

    // DELETE /api/videos/:id - Delete video
    const deleteMatch = path.match(/^\/api\/videos\/(\d+)$/);
    if (deleteMatch && method === "DELETE") {
      const user = checkAuth(req);
      if (!user) {
        return new Response("Unauthorized", { status: 401 });
      }

      const videoId = parseInt(deleteMatch[1]);
      const video = db.query("SELECT * FROM videos WHERE id = ?").get(videoId) as any;

      if (!video) {
        return new Response("Video not found", { status: 404 });
      }

      // Delete file
      try {
        await Bun.file(`./storage/videos/${video.filename}`).unlink();
      } catch (e) {
        // File might not exist
      }

      // Delete from database
      db.run("DELETE FROM videos WHERE id = ?", [videoId]);

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /api/user - Get current user info
    if (path === "/api/user" && method === "GET") {
      const user = checkAuth(req);
      if (!user) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json(user, { headers: corsHeaders });
    }

    // --- 404 ---
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Moments server running at http://localhost:${server.port}`);
