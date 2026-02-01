import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
import { AccessToken } from 'livekit-server-sdk';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public')));

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Initialize database
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS art (
        id TEXT PRIMARY KEY,
        author TEXT NOT NULL,
        title TEXT,
        size INTEGER NOT NULL,
        palette JSONB NOT NULL,
        pixels JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        views INTEGER DEFAULT 0,
        remix_of TEXT REFERENCES art(id)
      )
    `);
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_art_created ON art(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_art_author ON art(author)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_art_remix ON art(remix_of)`);
    
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

// Validation helpers
function validatePalette(palette) {
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > 256) {
    return false;
  }
  return palette.every(c => /^#[0-9A-Fa-f]{6}$/.test(c));
}

function validatePixels(pixels, size, paletteLength) {
  if (!Array.isArray(pixels) || pixels.length !== size) return false;
  for (const row of pixels) {
    if (!Array.isArray(row) || row.length !== size) return false;
    for (const p of row) {
      if (!Number.isInteger(p) || p < 0 || p >= paletteLength) return false;
    }
  }
  return true;
}

// API Routes

// List all art
app.get('/api/art', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const author = req.query.author;
    
    let query = 'SELECT * FROM art';
    const params = [];
    let paramIdx = 1;
    
    if (author) {
      query += ` WHERE author = $${paramIdx++}`;
      params.push(author);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    const countResult = await pool.query('SELECT COUNT(*) as count FROM art');
    
    const art = result.rows.map(row => ({
      id: row.id,
      author: row.author,
      title: row.title,
      size: row.size,
      palette: row.palette,
      pixels: row.pixels,
      created_at: row.created_at,
      views: row.views,
      remix_of: row.remix_of || null
    }));
    
    res.json({
      success: true,
      count: art.length,
      total: parseInt(countResult.rows[0].count),
      art
    });
  } catch (err) {
    console.error('Error listing art:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Get single art piece
app.get('/api/art/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM art WHERE id = $1', [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Art not found' });
    }
    
    const row = result.rows[0];
    
    // Increment views
    await pool.query('UPDATE art SET views = views + 1 WHERE id = $1', [req.params.id]);
    
    // Get original if this is a remix
    let original = null;
    if (row.remix_of) {
      const origResult = await pool.query('SELECT id, author, title FROM art WHERE id = $1', [row.remix_of]);
      if (origResult.rows.length > 0) {
        const origRow = origResult.rows[0];
        original = { id: origRow.id, author: origRow.author, title: origRow.title };
      }
    }
    
    // Get remixes of this piece
    const remixResult = await pool.query(
      'SELECT id, author, title FROM art WHERE remix_of = $1 ORDER BY created_at DESC LIMIT 10',
      [row.id]
    );
    
    res.json({
      success: true,
      art: {
        id: row.id,
        author: row.author,
        title: row.title,
        size: row.size,
        palette: row.palette,
        pixels: row.pixels,
        created_at: row.created_at,
        views: row.views + 1,
        remix_of: row.remix_of || null,
        original,
        remixes: remixResult.rows
      }
    });
  } catch (err) {
    console.error('Error getting art:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Create new art
app.post('/api/art', async (req, res) => {
  try {
    const { author, title, size, palette, pixels, remix_of } = req.body;
    
    // Validate required fields
    if (!author || typeof author !== 'string' || author.length > 64) {
      return res.status(400).json({ success: false, error: 'Invalid author (string, max 64 chars)' });
    }
    
    if (title && (typeof title !== 'string' || title.length > 128)) {
      return res.status(400).json({ success: false, error: 'Invalid title (string, max 128 chars)' });
    }
    
    // Validate size (32x32 only)
    if (size !== 32) {
      return res.status(400).json({ 
        success: false, 
        error: 'Size must be 32 (32x32 pixels)' 
      });
    }
    
    // Validate palette
    if (!validatePalette(palette)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid palette. Must be array of 1-256 hex colors (#RRGGBB)' 
      });
    }
    
    // Validate pixels
    if (!validatePixels(pixels, size, palette.length)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid pixels. Must be ${size}x${size} array of palette indices` 
      });
    }
    
    // Handle remix validation
    if (remix_of) {
      const origResult = await pool.query('SELECT * FROM art WHERE id = $1', [remix_of]);
      if (origResult.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Original art not found for remix' });
      }
      
      const originalRow = origResult.rows[0];
      const originalPixels = originalRow.pixels;
      const originalPalette = originalRow.palette;
      
      // Check 50% pixel change limit
      let changedPixels = 0;
      const maxChanges = Math.floor((size * size) * 0.5);
      
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const originalColor = originalPalette[originalPixels[y][x]];
          const newColor = palette[pixels[y][x]];
          if (originalColor !== newColor) {
            changedPixels++;
          }
        }
      }
      
      if (changedPixels > maxChanges) {
        return res.status(400).json({ 
          success: false, 
          error: `Too many pixels changed. Remixes can only modify up to 50% (${maxChanges} pixels). You changed ${changedPixels}.`
        });
      }
      
      if (changedPixels === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'No pixels changed. Make some modifications to remix!'
        });
      }
    }
    
    const id = uuidv4();
    
    await pool.query(
      `INSERT INTO art (id, author, title, size, palette, pixels, remix_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, author, title || null, size, JSON.stringify(palette), JSON.stringify(pixels), remix_of || null]
    );
    
    res.status(201).json({
      success: true,
      message: remix_of ? 'Remix published! 🎨🔀' : 'Art created! 🎨',
      id,
      url: `/art/${id}`,
      remix_of: remix_of || null
    });
  } catch (err) {
    console.error('Error creating art:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Get art as ASCII
app.get('/api/art/:id/ascii', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM art WHERE id = $1', [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Art not found' });
    }
    
    const row = result.rows[0];
    const pixels = row.pixels;
    const chars = ' .:-=+*#%@'.split('');
    const palette = row.palette;
    
    const brightness = palette.map(hex => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return (r + g + b) / (3 * 255);
    });
    
    const ascii = pixels.map(row => 
      row.map(p => chars[Math.floor(brightness[p] * (chars.length - 1))]).join('')
    ).join('\n');
    
    res.type('text/plain').send(ascii);
  } catch (err) {
    console.error('Error getting ASCII:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Render art as SVG
app.get('/art/:id/image', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM art WHERE id = $1', [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).send('Art not found');
    }
    
    const row = result.rows[0];
    const pixels = row.pixels;
    const palette = row.palette;
    const size = row.size;
    const scale = Math.max(1, Math.floor(512 / size));
    const canvasSize = size * scale;
    
    let rects = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const color = palette[pixels[y][x]];
        rects += `<rect x="${x * scale}" y="${y * scale}" width="${scale}" height="${scale}" fill="${color}"/>`;
      }
    }
    
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${canvasSize}" height="${canvasSize}" viewBox="0 0 ${canvasSize} ${canvasSize}">
  <title>${row.title || 'Untitled'} by ${row.author}</title>
  ${rects}
</svg>`;
    
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    console.error('Error rendering SVG:', err);
    res.status(500).send('Error rendering art');
  }
});

// View art page (HTML)
app.get('/art/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM art WHERE id = $1', [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).send('Art not found');
    }
    
    const row = result.rows[0];
    
    // Increment views
    await pool.query('UPDATE art SET views = views + 1 WHERE id = $1', [req.params.id]);
    
    const pixels = row.pixels;
    const palette = row.palette;
    const title = row.title || 'Untitled';
    const created = new Date(row.created_at).toLocaleDateString();
    
    // Get original if remix
    let originalInfo = null;
    if (row.remix_of) {
      const origResult = await pool.query('SELECT id, author, title FROM art WHERE id = $1', [row.remix_of]);
      if (origResult.rows.length > 0) originalInfo = origResult.rows[0];
    }
    
    // Get remixes of this piece
    const remixResult = await pool.query(
      'SELECT id, author, title FROM art WHERE remix_of = $1 ORDER BY created_at DESC LIMIT 10',
      [row.id]
    );
    const remixes = remixResult.rows;
    
    const remixHtml = originalInfo ? `
      <div class="remix-info">
        🔀 Remix of <a href="/art/${originalInfo.id}">${originalInfo.title || 'Untitled'}</a> by ${originalInfo.author}
      </div>
    ` : '';
    
    const remixesHtml = remixes.length > 0 ? `
      <div class="remixes">
        <h3>Remixes (${remixes.length})</h3>
        ${remixes.map(r => `<a href="/art/${r.id}">${r.title || 'Untitled'} by ${r.author}</a>`).join('')}
      </div>
    ` : '';
    
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} by ${row.author} — Badugi.ai</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Monaco', 'Menlo', monospace;
      background: #0a0a0f;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 800px; margin: 0 auto; }
    header { margin-bottom: 2rem; }
    .back { color: #4ecdc4; text-decoration: none; font-size: 0.9rem; }
    .back:hover { text-decoration: underline; }
    .art-frame {
      background: #16161e;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .canvas-container {
      display: flex;
      justify-content: center;
      margin-bottom: 1rem;
    }
    .canvas {
      display: grid;
      grid-template-columns: repeat(${row.size}, 1fr);
      gap: 0;
      width: min(100%, 512px);
      aspect-ratio: 1;
    }
    .pixel { aspect-ratio: 1; }
    .meta { color: #888; font-size: 0.9rem; }
    .meta .author { color: #ff6b6b; }
    .meta .title { color: #fff; font-weight: bold; }
    .stats { margin-top: 1rem; font-size: 0.8rem; color: #666; }
    .remix-info {
      margin-top: 1rem;
      padding: 0.75rem;
      background: #1a1a2e;
      border-radius: 4px;
      font-size: 0.85rem;
    }
    .remix-info a { color: #4ecdc4; }
    .palette {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-top: 1rem;
    }
    .palette-color {
      width: 24px;
      height: 24px;
      border-radius: 4px;
      border: 1px solid #333;
    }
    .actions { margin-top: 1.5rem; display: flex; gap: 1rem; flex-wrap: wrap; }
    .actions a {
      padding: 0.5rem 1rem;
      background: #16161e;
      border: 1px solid #333;
      border-radius: 4px;
      color: #4ecdc4;
      text-decoration: none;
      font-size: 0.85rem;
    }
    .actions a:hover { background: #1a1a2e; }
    .actions a.remix-btn {
      background: #4ecdc4;
      color: #0a0a0f;
      border-color: #4ecdc4;
      font-weight: bold;
    }
    .actions a.remix-btn:hover { background: #45b7aa; }
    .remixes {
      margin-top: 1.5rem;
      padding: 1rem;
      background: #16161e;
      border-radius: 8px;
    }
    .remixes h3 { font-size: 0.9rem; color: #888; margin-bottom: 0.75rem; }
    .remixes a {
      display: block;
      padding: 0.5rem;
      color: #4ecdc4;
      text-decoration: none;
      font-size: 0.85rem;
    }
    .remixes a:hover { background: #1a1a2e; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <a href="/" class="back">← Back to Gallery</a>
    </header>
    <div class="art-frame">
      <div class="canvas-container">
        <div class="canvas" id="canvas"></div>
      </div>
      <div class="meta">
        <span class="title">${title}</span>
        <span>by <span class="author">${row.author}</span></span>
      </div>
      <div class="stats">${row.size}×${row.size} · ${row.views + 1} views · ${created}</div>
      ${remixHtml}
      <div class="palette" id="palette"></div>
    </div>
    <div class="actions">
      <a href="/remix/${row.id}" class="remix-btn">🔀 Remix</a>
      <a href="/art/${row.id}/image" target="_blank">View SVG</a>
      <a href="/api/art/${row.id}">View JSON</a>
      <a href="/api/art/${row.id}/ascii">View ASCII</a>
    </div>
    ${remixesHtml}
  </div>
  <script>
    const pixels = ${JSON.stringify(pixels)};
    const palette = ${JSON.stringify(palette)};
    const canvas = document.getElementById('canvas');
    pixels.forEach(row => {
      row.forEach(colorIdx => {
        const div = document.createElement('div');
        div.className = 'pixel';
        div.style.backgroundColor = palette[colorIdx];
        canvas.appendChild(div);
      });
    });
    const paletteEl = document.getElementById('palette');
    palette.forEach(color => {
      const div = document.createElement('div');
      div.className = 'palette-color';
      div.style.backgroundColor = color;
      div.title = color;
      paletteEl.appendChild(div);
    });
  </script>
</body>
</html>`);
  } catch (err) {
    console.error('Error rendering page:', err);
    res.status(500).send('Error loading art');
  }
});

// Static pages
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));
app.get('/draw', (req, res) => res.sendFile(join(__dirname, 'public', 'draw.html')));
app.get('/camera', (req, res) => res.sendFile(join(__dirname, 'public', 'camera.html')));
app.get('/api', (req, res) => res.sendFile(join(__dirname, 'public', 'api.html')));

// LiveKit config
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://localhost:7880';

// LiveKit token endpoint
app.post('/api/token', async (req, res) => {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(503).json({ error: 'LiveKit not configured' });
  }
  
  try {
    const { roomName, participantName } = req.body;
    
    if (!roomName) {
      return res.status(400).json({ error: 'roomName required' });
    }
    
    const name = participantName || 'user_' + crypto.randomBytes(4).toString('hex');
    
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: name,
      name: name,
    });
    
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
    });
    
    const jwt = await token.toJwt();
    
    res.json({
      token: jwt,
      identity: name,
      roomName,
      livekitUrl: LIVEKIT_URL,
    });
  } catch (err) {
    console.error('Token error:', err);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// Room pages
app.get('/room', (req, res) => res.sendFile(join(__dirname, 'public', 'room.html')));
app.get('/room/:id', (req, res) => res.sendFile(join(__dirname, 'public', 'room.html')));

app.get('/remix/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT id FROM art WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Art not found');
    }
    res.sendFile(join(__dirname, 'public', 'remix.html'));
  } catch (err) {
    res.status(500).send('Error');
  }
});

// Initialize DB on startup
let dbInitialized = false;
async function ensureDB() {
  if (!dbInitialized) {
    await initDB();
    dbInitialized = true;
  }
}

// Middleware to ensure DB is ready
app.use(async (req, res, next) => {
  try {
    await ensureDB();
    next();
  } catch (err) {
    console.error('DB init error:', err);
    res.status(500).json({ error: 'Database unavailable' });
  }
});

// For local development
if (process.env.NODE_ENV !== 'production') {
  ensureDB().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🎨 Badugi.ai running at http://0.0.0.0:${PORT}`);
    });
  }).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
}

// Export for Vercel
export default app;
