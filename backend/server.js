require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const {
  createVideoTask,
  getVideoStatus,
} = require('./agnes-video');

const app = express();

const PORT = process.env.PORT || 3000;

const jobs = new Map();

const MAX_JOB_TIME = 5 * 60 * 1000;
const POLL_INTERVAL = 5000;

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
    ],
  })
);

app.use(
  express.json({
    limit: '2mb',
  })
);

function createJobId() {
  return crypto.randomUUID();
}

function toClientResponse(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress || 0,
    videoUrl: job.videoUrl || null,
    error: job.error || null,
  };
}

app.get('/', (req, res) => {
  res.json({
    message: 'AI Blender Video Maker API',
    status: 'running',
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'AI Blender Video Maker',
    watermark: false,
    model: 'agnes-video-v2.0',
    width: 1152,
    height: 768,
    num_frames: 289,
    frame_rate: 24,
    duration: 289 / 24,
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    watermark: false,
    model: 'agnes-video-v2.0',
    width: 1152,
    height: 768,
    num_frames: 289,
    frame_rate: 24,
    duration: 289 / 24,
  });
});

app.post('/api/generate', async (req, res) => {
  const prompt = req.body?.prompt;

  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({
      error: 'Prompt is required.',
    });
  }

  const jobId = createJobId();

  const job = {
    jobId,

    status: 'processing',
    progress: 5,

    videoUrl: null,
    error: null,

    agnesVideoId: null,
    agnesTaskId: null,

    createdAt: Date.now(),
    updatedAt: Date.now(),

    nextPollAt: 0,
  };

  jobs.set(jobId, job);

  console.log('==========================================');
  console.log('[Generate] New job:', jobId);
  console.log('[Generate] Prompt:', String(prompt).trim());
  console.log('==========================================');

  try {
    const result = await createVideoTask(
      String(prompt).trim()
    );

    job.agnesVideoId = result.videoId;
    job.agnesTaskId = result.taskId;

    job.status = 'processing';
    job.progress = Math.max(
      5,
      Math.min(
        95,
        Number(result.progress) || 5
      )
    );

    job.updatedAt = Date.now();
    job.nextPollAt = 0;

    console.log(
      '[Generate] Agnes video_id:',
      job.agnesVideoId
    );

    console.log(
      '[Generate] Agnes task_id:',
      job.agnesTaskId
    );

    return res.status(200).json(
      toClientResponse(job)
    );
  } catch (error) {
    console.error(
      '[Generate] Error:',
      error.message
    );

    job.status = 'failed';
    job.error = error.message;
    job.updatedAt = Date.now();

    return res.status(500).json(
      toClientResponse(job)
    );
  }
});

app.get('/api/status/:jobId', async (req, res) => {
  const { jobId } = req.params;

  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      jobId,
      status: 'failed',
      progress: 0,
      videoUrl: null,
      error: 'Job not found.',
    });
  }

  // Already completed
  if (
    job.status === 'completed' &&
    job.videoUrl
  ) {
    return res.json(
      toClientResponse(job)
    );
  }

  // Already failed
  if (job.status === 'failed') {
    return res.json(
      toClientResponse(job)
    );
  }

  // Timeout
  if (
    Date.now() - job.createdAt >
    MAX_JOB_TIME
  ) {
    job.status = 'failed';
    job.error =
      'Video generation timed out after 5 minutes.';
    job.updatedAt = Date.now();

    return res.json(
      toClientResponse(job)
    );
  }

  // Prevent unnecessary polling
  if (
    job.nextPollAt &&
    Date.now() < job.nextPollAt
  ) {
    return res.json(
      toClientResponse(job)
    );
  }

  job.nextPollAt =
    Date.now() + POLL_INTERVAL;

  try {
    console.log('==========================================');
    console.log('[Status] Job:', jobId);
    console.log(
      '[Status] Agnes video_id:',
      job.agnesVideoId
    );
    console.log('[Status] Polling Agnes...');
    console.log('==========================================');

    const result =
      await getVideoStatus(
        job.agnesVideoId
      );

    console.log(
      '[Status] status:',
      result.status
    );

    console.log(
      '[Status] progress:',
      result.progress
    );

    console.log(
      '[Status] videoUrl:',
      result.videoUrl
    );

    // ==========================================
    // COMPLETED
    // ==========================================

    if (
      result.status === 'completed'
    ) {
      if (!result.videoUrl) {
        console.warn(
          '[Status] Agnes completed but URL is missing.'
        );

        job.status = 'processing';
        job.progress = 95;
        job.error = null;
        job.updatedAt = Date.now();

        return res.json(
          toClientResponse(job)
        );
      }

      // IMPORTANT:
      // Direct Agnes URL.
      // No watermark.
      // No /tmp filesystem.
      // No local generated file.
      job.videoUrl =
        result.videoUrl;

      job.status = 'completed';
      job.progress = 100;
      job.error = null;
      job.updatedAt = Date.now();

      console.log('==========================================');
      console.log('[Status] VIDEO READY');
      console.log('[Status] Job:', jobId);
      console.log(
        '[Status] Video URL:',
        job.videoUrl
      );
      console.log('==========================================');

      return res.json(
        toClientResponse(job)
      );
    }

    // ==========================================
    // FAILED
    // ==========================================

    if (
      result.status === 'failed' ||
      result.status === 'error' ||
      result.status === 'cancelled'
    ) {
      job.status = 'failed';
      job.progress =
        Number(result.progress) || 0;

      job.error =
        result.error ||
        'Agnes video generation failed.';

      job.updatedAt = Date.now();

      return res.json(
        toClientResponse(job)
      );
    }

    // ==========================================
    // PROCESSING
    // ==========================================

    job.status = 'processing';

    job.progress = Math.max(
      5,
      Math.min(
        95,
        Number(result.progress) || 0
      )
    );

    job.error = null;
    job.updatedAt = Date.now();

    return res.json(
      toClientResponse(job)
    );
  } catch (error) {
    console.error(
      '[Status] Polling error:',
      error.message
    );

    // Temporary polling error should not
    // immediately destroy the job.
    job.status = 'processing';

    job.progress = Math.max(
      5,
      Math.min(
        95,
        job.progress || 5
      )
    );

    job.updatedAt = Date.now();

    return res.json(
      toClientResponse(job)
    );
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log('==========================================');
    console.log('AI Blender Video Maker Backend');
    console.log('==========================================');
    console.log(`Port: ${PORT}`);
    console.log('Watermark: DISABLED');
    console.log('Model: agnes-video-v2.0');
    console.log('Resolution: 1152x768');
    console.log('Frames: 289');
    console.log('FPS: 24');
    console.log('Duration: ~12.04 seconds');
    console.log('==========================================');
  });
}

module.exports = app;