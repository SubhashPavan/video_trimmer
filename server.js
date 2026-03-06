const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

// Use OS ffmpeg in production (Docker), npm binaries locally
try {
  const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  const ffprobePath = require('@ffprobe-installer/ffprobe').path;
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);
  console.log('Using npm ffmpeg:', ffmpegPath);
} catch {
  console.log('Using system ffmpeg');
}

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || String(2 * 1024 * 1024 * 1024)); // 2GB default
const CLEANUP_AGE_MS = parseInt(process.env.CLEANUP_AGE_MS || String(30 * 60 * 1000)); // 30 min default

// Ensure temp directories exist
const uploadDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

// Multer config
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// Serve static files
app.use(express.static(path.join(__dirname)));
app.use('/output', express.static(outputDir));
app.use(express.json());

// ─── Health checks for Kubernetes ───
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/readyz', (req, res) => {
  // Check that upload/output dirs are writable
  try {
    fs.accessSync(uploadDir, fs.constants.W_OK);
    fs.accessSync(outputDir, fs.constants.W_OK);
    res.status(200).json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not ready' });
  }
});

// ─── Upload video ───
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filePath = req.file.path;

  ffmpeg.ffprobe(filePath, (err, metadata) => {
    if (err) {
      console.error('ffprobe error:', err.message);
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Invalid video file: ' + err.message });
    }

    res.json({
      id: path.basename(filePath, path.extname(filePath)),
      originalName: req.file.originalname,
      duration: metadata.format.duration,
      filePath: filePath
    });
  });
});

// ─── Split video ───
app.post('/api/split', async (req, res) => {
  const { id, originalName, cutPoints } = req.body;

  if (!id || !cutPoints || !Array.isArray(cutPoints)) {
    return res.status(400).json({ error: 'Missing id or cutPoints' });
  }

  // Find uploaded file
  const files = fs.readdirSync(uploadDir);
  const inputFile = files.find(f => f.startsWith(id));
  if (!inputFile) return res.status(404).json({ error: 'Video not found' });

  const inputPath = path.join(uploadDir, inputFile);

  // Get duration
  const duration = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, meta) => {
      if (err) reject(err);
      else resolve(meta.format.duration);
    });
  });

  // Build segments
  const points = [0, ...cutPoints.sort((a, b) => a - b), duration];
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    segments.push({ start: points[i], end: points[i + 1] });
  }

  const baseName = originalName.replace(/\.[^.]+$/, '');
  const sessionDir = path.join(outputDir, id);
  fs.mkdirSync(sessionDir, { recursive: true });

  const results = [];

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const outputName = `${baseName}_part${i + 1}.mp4`;
      const outputPath = path.join(sessionDir, outputName);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .setStartTime(seg.start)
          .setDuration(seg.end - seg.start)
          .outputOptions(['-c', 'copy', '-avoid_negative_ts', 'make_zero'])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      results.push({
        name: outputName,
        url: `/output/${id}/${encodeURIComponent(outputName)}`,
        start: seg.start,
        end: seg.end
      });
    }

    res.json({ segments: results });
  } catch (err) {
    console.error('Split error:', err);
    res.status(500).json({ error: 'Failed to split video: ' + err.message });
  }
});

// ─── Download a part ───
app.get('/api/download/:id/:filename', (req, res) => {
  const filePath = path.join(outputDir, req.params.id, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

// ─── Cleanup endpoint (called by frontend) ───
app.delete('/api/cleanup/:id', (req, res) => {
  cleanupSession(req.params.id);
  res.json({ ok: true });
});

function cleanupSession(id) {
  try {
    const sessionDir = path.join(outputDir, id);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true });
    }
    const uploadFiles = fs.readdirSync(uploadDir).filter(f => f.startsWith(id));
    uploadFiles.forEach(f => fs.unlinkSync(path.join(uploadDir, f)));
  } catch (err) {
    console.error('Cleanup error for', id, err.message);
  }
}

// ─── Auto-cleanup: delete files older than CLEANUP_AGE_MS ───
function autoCleanup() {
  const now = Date.now();

  // Clean uploads
  try {
    for (const file of fs.readdirSync(uploadDir)) {
      const filePath = path.join(uploadDir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > CLEANUP_AGE_MS) {
        fs.unlinkSync(filePath);
        console.log('Auto-cleaned upload:', file);
      }
    }
  } catch (err) {
    console.error('Upload cleanup error:', err.message);
  }

  // Clean output sessions
  try {
    for (const dir of fs.readdirSync(outputDir)) {
      const dirPath = path.join(outputDir, dir);
      const stat = fs.statSync(dirPath);
      if (stat.isDirectory() && now - stat.mtimeMs > CLEANUP_AGE_MS) {
        fs.rmSync(dirPath, { recursive: true });
        console.log('Auto-cleaned output:', dir);
      }
    }
  } catch (err) {
    console.error('Output cleanup error:', err.message);
  }
}

// Run cleanup every 5 minutes
setInterval(autoCleanup, 5 * 60 * 1000);

// ─── Graceful shutdown ───
function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}

const server = app.listen(PORT, () => {
  console.log(`Video Cutter server running on port ${PORT}`);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
