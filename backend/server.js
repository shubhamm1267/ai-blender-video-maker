const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const axios = require('axios');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');

const { createVideoTask, getVideoStatus } = require('./agnes-video');
const { promptRouter, logPromptStartupState } = require('./prompt-routes');

const app = express();
const PORT = process.env.PORT || 3000;

const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const AGNES_POLL_INTERVAL_MS = 20 * 1000;
const AGNES_RATE_LIMIT_BACKOFF_MS = 60 * 1000;

const GENERATED_DIR = path.join(__dirname, 'generated');
const WATERMARK_TEXT = (process.env.CHANNEL_WATERMARK || 'MarbleVortex3D').trim();
const WATERMARK_OPACITY = Math.min(1, Math.max(0.15, Number(process.env.WATERMARK_OPACITY || 0.72)));

fs.mkdirSync(GENERATED_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/generated', express.static(GENERATED_DIR, {
  maxAge: '1h',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

const jobs = new Map();

function mapStatus(agnesStatus) {
  switch (agnesStatus) {
    case 'queued': return 'pending';
    case 'in_progress': return 'processing';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    default: return 'processing';
  }
}

function toClientResponse(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    videoUrl: job.videoUrl,
    error: job.error,
  };
}

/*
 * The generator is still a generative-video model, not a rigid physics solver.
 * This "physics director" prefix makes the requested physical constraints
 * explicit to the model before it sees the user's creative description.
 */
function buildPhysicsDirectedPrompt(userPrompt) {
  return `
PHYSICS-DIRECTED VIDEO SPECIFICATION:
Create the scene as one continuous, physically coherent 5-second shot. Treat
gravity, mass, inertia, friction, collision response, contact forces and
momentum as real constraints. Every moving object must remain supported by
visible geometry or a continuous fluid/particle path. No floating, teleporting,
popping, clipping through surfaces, impossible acceleration, or unexplained
direction changes. Keep object dimensions, material properties and relative
positions consistent from frame to frame. Rolling objects should visibly rotate
in proportion to their travel distance and should roll without slipping when
traction permits. Impacts must show believable momentum transfer, contact
deformation or rebound, and small secondary vibrations when appropriate.
Mechanical parts must remain meshed and driven by their contacts. Camera is
locked unless motion is explicitly requested. Prioritize temporal consistency,
stable geometry and realistic motion over decorative effects.

USER CREATIVE BRIEF:
${userPrompt.trim()}
`.trim();
}

function getFontFile() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf'),
        path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'segoeui.ttf'),
      ]
    : process.platform === 'darwin'
      ? ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf']
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'];

  return candidates.find((p) => fs.existsSync(p)) || null;
}

function escapeDrawtext(value) {
  // drawtext filter escaping: backslash, single quote, colon.
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

async function downloadFile(url, target) {
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 120000,
    maxRedirects: 5,
    headers: { 'User-Agent': 'MarbleVortex3D-LocalVideoRenderer/1.0' },
  });

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    response.data.pipe(out);
    response.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });
}

function burnWatermark(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const fontFile = getFontFile();
    const text = escapeDrawtext(WATERMARK_TEXT);
    const fontPart = fontFile ? `fontfile='${escapeDrawtext(fontFile)}':` : '';
    const filter =
      `drawtext=${fontPart}` +
      `text='${text}':fontcolor=white@${WATERMARK_OPACITY}:fontsize=28:` +
      `x=w-tw-32:y=h-th-28:shadowcolor=black@0.35:shadowx=1:shadowy=1`;

    const args = [
      '-y',
      '-i', inputPath,
      '-vf', filter,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outputPath,
    ];

    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg watermark render failed (exit ${code}). ${stderr.slice(-1200)}`));
    });
  });
}

async function renderWatermarkedVideo(sourceUrl, jobId) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'marblevortex3d-'));
  const inputPath = path.join(workDir, 'source.mp4');
  const outputName = `${jobId}.mp4`;
  const outputPath = path.join(GENERATED_DIR, outputName);

  try {
    await downloadFile(sourceUrl, inputPath);
    await burnWatermark(inputPath, outputPath);
    return `/generated/${outputName}`;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

app.post('/api/generate', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

  if (!prompt) return res.status(400).json({ error: 'Prompt cannot be empty.' });

  if (!process.env.AGNES_API_KEY) {
    return res.status(500).json({
      error: 'Server is missing AGNES_API_KEY. Add it to backend/.env and restart.',
    });
  }

  try {
    const task = await createVideoTask(buildPhysicsDirectedPrompt(prompt));
    const jobId = crypto.randomUUID();
    const now = Date.now();

    jobs.set(jobId, {
      jobId,
      prompt,
      agnesTaskId: task.taskId,
      agnesVideoId: task.videoId,
      status: mapStatus(task.status),
      progress: task.progress,
      videoUrl: null,
      sourceVideoUrl: null,
      error: null,
      createdAt: now,
      nextAgnesCheckAt: now,
    });

    return res.status(201).json({ jobId, status: mapStatus(task.status) });
  } catch (err) {
    console.error('[generate] Agnes AI error:', err.message);
    const status = err.status === 429 ? 429 : err.status && err.status < 500 ? err.status : 502;
    return res.status(status).json({ error: err.message, retryAfter: err.retryAfter });
  }
});

app.get('/api/status/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Unknown job ID. It may have expired — try generating again.' });
  }

  if (job.status === 'completed' || job.status === 'failed') {
    return res.json(toClientResponse(job));
  }

  if (Date.now() - job.createdAt > JOB_TIMEOUT_MS) {
    job.status = 'failed';
    job.error = 'Video generation timed out after 5 minutes.';
    return res.json(toClientResponse(job));
  }

  if (Date.now() < job.nextAgnesCheckAt) {
    return res.json(toClientResponse(job));
  }

  try {
    const result = await getVideoStatus({
      videoId: job.agnesVideoId,
      taskId: job.agnesTaskId,
    });

    job.nextAgnesCheckAt = Date.now() + AGNES_POLL_INTERVAL_MS;
    job.status = mapStatus(result.status);
    job.progress = result.progress;

    if (job.status === 'completed' && result.videoUrl) {
      job.progress = 95;
      job.sourceVideoUrl = result.videoUrl;

      try {
        console.log(`[render] Burning ${WATERMARK_TEXT} watermark into ${job.jobId}...`);
        job.videoUrl = await renderWatermarkedVideo(result.videoUrl, job.jobId);
        job.progress = 100;
      } catch (renderErr) {
        console.error('[render] Watermark error:', renderErr.message);
        job.status = 'failed';
        job.error = `Video was generated, but the final watermark render failed: ${renderErr.message}`;
        return res.json(toClientResponse(job));
      }
    }

    if (job.status === 'failed') {
      job.error =
        (result.error && (result.error.message || JSON.stringify(result.error))) ||
        'Video generation failed on Agnes AI.';
    }

    return res.json(toClientResponse(job));
  } catch (err) {
    console.error('[status] Agnes AI error:', err.message);

    if (err.status === 404 || err.status === 401 || err.status === 403) {
      job.status = 'failed';
      job.error = err.message;
      return res.json(toClientResponse(job));
    }

    const backoffMs =
      err.status === 429
        ? Math.max((err.retryAfter || 0) * 1000, AGNES_RATE_LIMIT_BACKOFF_MS)
        : AGNES_POLL_INTERVAL_MS;

    job.nextAgnesCheckAt = Date.now() + backoffMs;
    return res.json(toClientResponse(job));
  }
});

app.get('/api/config', (_req, res) => {
  res.json({
    watermark: WATERMARK_TEXT,
    physicsDirected: true,
    finalVideoHasBurnedWatermark: true,
  });
});

app.use('/api/prompt', promptRouter);

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(PORT, () => {
  console.log(`✅ Text-to-Video backend running on http://localhost:${PORT}`);
  console.log(`🎬 Physics-directed generation: ON`);
  console.log(`🔖 Burned-in watermark: ${WATERMARK_TEXT}`);
  if (!process.env.AGNES_API_KEY) {
    console.warn('⚠️ AGNES_API_KEY is not set — add it to backend/.env before generating videos.');
  }
  logPromptStartupState();
});
