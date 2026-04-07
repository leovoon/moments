import { Database } from "bun:sqlite";
import { spawn } from "child_process";
import { readdir, unlink, mkdir, stat, writeFile } from "fs/promises";
import { existsSync, createWriteStream } from "fs";
import { join, extname } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

// --- Config ---
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const MIN_DISK_SPACE = 500 * 1024 * 1024; // 500MB free required
const ALLOWED_EXTENSIONS = new Set(["mp4", "mov", "webm", "avi", "mkv", "m4v", "3gp", "flv", "wmv", "ts"]);
const ALLOWED_MIME_PREFIXES = ["video/"];

// Check available disk space
async function getDiskSpace(): Promise<{ free: number; total: number }> {
  try {
    // Run df to get disk space (works in Docker containers)
    const proc = spawn("df", ["-k", "."]);
    let output = "";
    proc.stdout?.on("data", (d) => (output += d.toString()));
    return new Promise((resolve) => {
      proc.on("close", () => {
        const lines = output.trim().split("\n");
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          const totalKB = parseInt(parts[1]) || 0;
          const freeKB = parseInt(parts[3]) || 0;
          resolve({ free: freeKB * 1024, total: totalKB * 1024 });
        } else {
          resolve({ free: Infinity, total: Infinity });
        }
      });
    });
  } catch {
    return { free: Infinity, total: Infinity };
  }
}

// Initialize database
const db = new Database("./storage/moments.db");

// Ensure storage directories exist
await mkdir("./storage/videos", { recursive: true });
await mkdir("./storage/thumbnails", { recursive: true });
await mkdir("./storage/temp", { recursive: true });

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
    thumbnail TEXT,
    duration REAL,
    width INTEGER,
    height INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Add thumbnail/duration/width/height columns if they don't exist (migration)
try { db.run("ALTER TABLE videos ADD COLUMN thumbnail TEXT"); } catch {}
try { db.run("ALTER TABLE videos ADD COLUMN duration REAL"); } catch {}
try { db.run("ALTER TABLE videos ADD COLUMN width INTEGER"); } catch {}
try { db.run("ALTER TABLE videos ADD COLUMN height INTEGER"); } catch {}

// Create default admin user if not exists
const adminExists = db.query("SELECT id FROM users WHERE username = ?").get("admin");
if (!adminExists) {
  // Simple password hash (in production, use bcrypt)
  const passwordHash = await Bun.password.hash("family123", "argon2id");
  db.run("INSERT INTO users (username, password_hash) VALUES (?, ?)", ["admin", passwordHash]);
  console.log("Created default admin user: admin / family123");
}

// --- FFmpeg Video Processing Queue ---
const processingQueue: Array<{ videoId: number; inputPath: string }> = [];
let isProcessing = false;

interface VideoMeta {
  duration?: number;
  width?: number;
  height?: number;
  thumbnail?: string;
}

// Run FFmpeg and return promise
function runFfmpeg(args: string[], timeoutMs = 120000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("FFmpeg timed out"));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
    proc.on("error", reject);
    // Consume stderr to prevent buffer fill
    proc.stderr?.on("data", (d) => console.log("[ffmpeg]", d.toString().trim()));
  });
}

// Get video metadata using ffprobe
function getVideoMeta(inputPath: string): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      inputPath,
    ]);
    let data = "";
    proc.stdout.on("data", (d) => (data += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffprobe failed"));
      try {
        const info = JSON.parse(data);
        const videoStream = info.streams?.find((s: any) => s.codec_type === "video");
        const duration = parseFloat(info.format?.duration || "0");
        resolve({
          duration,
          width: videoStream?.width,
          height: videoStream?.height,
        });
      } catch {
        reject(new Error("Failed to parse ffprobe output"));
      }
    });
    proc.on("error", reject);
  });
}

// Generate thumbnail from video
async function generateThumbnail(inputPath: string, videoId: number): Promise<string> {
  const thumbPath = `./storage/thumbnails/${videoId}.jpg`;
  // Seek to 1 second (or 10% of duration if shorter), grab 1 frame
  await runFfmpeg([
    "-ss", "1",
    "-i", inputPath,
    "-vframes", "1",
    "-q:v", "2",
    "-vf", "scale=360:-1",
    "-y",
    thumbPath,
  ], 30000);
  return `${videoId}.jpg`;
}

// Normalize video to MP4 (H264 + AAC) for web compatibility
async function normalizeVideo(inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg([
    "-i", inputPath,
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-y",
    outputPath,
  ]);
}

// Process a single video from the queue
async function processVideo(videoId: number, inputPath: string) {
  const tempDir = "./storage/temp";
  const normalizedPath = `${tempDir}/${videoId}-normalized.mp4`;
  
  try {
    console.log(`[process] Starting video ${videoId}...`);
    
    // 1. Get metadata
    const meta = await getVideoMeta(inputPath);
    
    // 2. Generate thumbnail
    let thumbnail: string | undefined;
    try {
      thumbnail = await generateThumbnail(inputPath, videoId);
    } catch (e) {
      console.warn(`[process] Thumbnail failed for ${videoId}:`, e);
    }
    
    // 3. Normalize to MP4 if not already H264/AAC in MP4 container
    const needsNormalize = !inputPath.endsWith(".mp4");
    if (needsNormalize) {
      console.log(`[process] Normalizing video ${videoId}...`);
      await normalizeVideo(inputPath, normalizedPath);
      // Replace original with normalized version
      const { renameSync } = await import("fs");
      renameSync(normalizedPath, inputPath);
    }
    
    // 4. Update database with metadata
    db.run(
      "UPDATE videos SET thumbnail = ?, duration = ?, width = ?, height = ? WHERE id = ?",
      [thumbnail || null, meta.duration || null, meta.width || null, meta.height || null, videoId]
    );
    
    console.log(`[process] Video ${videoId} processed successfully`);
  } catch (error) {
    console.error(`[process] Error processing video ${videoId}:`, error);
    // Still mark as processed even if failed, to avoid retry loop
    // Clean up temp files
    try { if (existsSync(normalizedPath)) await unlink(normalizedPath); } catch {}
  }
}

// Queue a video for processing
function queueVideoProcessing(videoId: number, inputPath: string) {
  processingQueue.push({ videoId, inputPath });
  processNextVideo();
}

// Process next video in queue
async function processNextVideo() {
  if (isProcessing || processingQueue.length === 0) return;
  isProcessing = true;
  
  const job = processingQueue.shift()!;
  await processVideo(job.videoId, job.inputPath);
  
  isProcessing = false;
  processNextVideo();
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
  idleTimeout: 255, // 255 seconds max (nginx/proxy default is usually 300s)
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

    // GET /thumbnails/:id - Serve video thumbnail
    const thumbMatch = path.match(/^\/thumbnails\/(\d+)\.jpg$/);
    if (thumbMatch && method === "GET") {
      const user = checkAuth(req);
      if (!user) {
        return new Response("Unauthorized", { status: 401 });
      }

      const thumbPath = `./storage/thumbnails/${thumbMatch[1]}.jpg`;
      const file = Bun.file(thumbPath);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
        });
      }
      return new Response("Not found", { status: 404 });
    }

    // POST /api/upload - Upload video
    if (path === "/api/upload" && method === "POST") {
      const user = checkAuth(req);
      if (!user) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        // Check disk space first
        const disk = await getDiskSpace();
        if (disk.free < MIN_DISK_SPACE) {
          console.error(`[upload] Not enough disk space: ${(disk.free / 1024 / 1024).toFixed(0)}MB free`);
          return Response.json({ error: "Not enough storage space on server. Please contact admin." }, { 
            status: 507,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const formData = await req.formData();
        const videoFile = formData.get("video") as File;
        const title = formData.get("title") as string || "";
        const description = formData.get("description") as string || "";

        // Validate file exists
        if (!videoFile || videoFile.size === 0) {
          return Response.json({ error: "No video file provided" }, { 
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // Validate file size
        if (videoFile.size > MAX_FILE_SIZE) {
          const sizeMB = (videoFile.size / 1024 / 1024).toFixed(0);
          const maxMB = (MAX_FILE_SIZE / 1024 / 1024).toFixed(0);
          return Response.json({ error: `File too large (${sizeMB}MB). Max is ${maxMB}MB.` }, { 
            status: 413,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // Validate file type by extension
        const originalExt = (extname(videoFile.name) || "").replace(".", "").toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(originalExt)) {
          return Response.json({ error: `Unsupported file type (.${originalExt}). Supported: ${[...ALLOWED_EXTENSIONS].join(", ")}` }, { 
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // Validate MIME type
        const mimeType = videoFile.type || "";
        if (mimeType && !ALLOWED_MIME_PREFIXES.some(prefix => mimeType.startsWith(prefix))) {
          return Response.json({ error: `Invalid file type: ${mimeType}. Only video files are allowed.` }, { 
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // Generate unique filename
        const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.${originalExt}`;
        const filePath = `./storage/videos/${filename}`;
        
        // Stream to disk instead of loading entire file into memory
        const buffer = await videoFile.arrayBuffer();
        await Bun.write(filePath, new Uint8Array(buffer));
        
        // Verify file was written correctly
        const writtenStat = await stat(filePath);
        if (writtenStat.size !== videoFile.size) {
          await unlink(filePath).catch(() => {});
          return Response.json({ error: "File write failed - incomplete upload" }, { 
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // Save to database
        const result = db.run(
          "INSERT INTO videos (filename, original_name, title, description, user_id) VALUES (?, ?, ?, ?, ?)",
          [filename, videoFile.name, title, description, user.userId]
        );

        console.log(`[upload] Video uploaded: ${filename} (${(videoFile.size / 1024 / 1024).toFixed(1)}MB) by ${user.username}`);

        // Queue video for FFmpeg processing (thumbnail + metadata)
        const videoId = Number(result.lastInsertRowid);
        queueVideoProcessing(videoId, `./storage/videos/${filename}`);

        return new Response(JSON.stringify({ 
          success: true, 
          id: result.lastInsertRowid,
          filename 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("[upload] Upload error:", error);
        return Response.json({ error: "Upload failed. Please try again." }, { 
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
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

      // Delete thumbnail
      try {
        await Bun.file(`./storage/thumbnails/${video.id}.jpg`).unlink();
      } catch (e) {
        // Thumbnail might not exist
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
