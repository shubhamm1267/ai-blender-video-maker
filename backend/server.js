const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '.env')
});

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const axios = require('axios');

const {
  createVideoTask,
  getVideoStatus
} = require('./agnes-video');

const {
  promptRouter,
  logPromptStartupState
} = require('./prompt-routes');

const app = express();

const PORT =
  process.env.PORT || 3000;

const JOB_TIMEOUT_MS =
  5 * 60 * 1000;

const AGNES_POLL_INTERVAL_MS =
  20 * 1000;

const AGNES_RATE_LIMIT_BACKOFF_MS =
  60 * 1000;

const GENERATED_DIR =
  path.join(
    os.tmpdir(),
    'generated'
  );

// ============================================================
// CREATE GENERATED DIRECTORY
// ============================================================

fs.mkdirSync(
  GENERATED_DIR,
  {
    recursive: true
  }
);

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  cors()
);

app.use(
  express.json({
    limit: '2mb'
  })
);

// ============================================================
// GENERATED VIDEO FILES
// ============================================================

app.use(
  '/generated',
  express.static(
    GENERATED_DIR,
    {
      maxAge: '1h',

      setHeaders(res) {
        res.setHeader(
          'Cache-Control',
          'public, max-age=3600'
        );

        res.setHeader(
          'Accept-Ranges',
          'bytes'
        );
      }
    }
  )
);

// ============================================================
// JOB STORAGE
// ============================================================

const jobs = new Map();

// ============================================================
// STATUS MAPPING
// ============================================================

function mapStatus(
  agnesStatus
) {
  switch (agnesStatus) {
    case 'queued':
      return 'pending';

    case 'in_progress':
      return 'processing';

    case 'processing':
      return 'processing';

    case 'completed':
      return 'completed';

    case 'failed':
      return 'failed';

    default:
      return 'processing';
  }
}

// ============================================================
// ABSOLUTE VIDEO URL
// ============================================================

function makeAbsoluteVideoUrl(
  req,
  videoUrl
) {
  if (!videoUrl) {
    return null;
  }

  // Already absolute URL
  if (
    /^https?:\/\//i.test(
      videoUrl
    )
  ) {
    return videoUrl;
  }

  const protocol =
    req.headers[
      'x-forwarded-proto'
    ] ||
    (
      req.secure
        ? 'https'
        : 'http'
    );

  const host =
    req.headers[
      'x-forwarded-host'
    ] ||
    req.get('host');

  const normalizedPath =
    videoUrl.startsWith('/')
      ? videoUrl
      : `/${videoUrl}`;

  return `${protocol}://${host}${normalizedPath}`;
}

// ============================================================
// CLIENT RESPONSE
// ============================================================

function toClientResponse(
  job,
  req
) {
  return {
    jobId:
      job.jobId,

    status:
      job.status,

    progress:
      job.progress,

    videoUrl:
      makeAbsoluteVideoUrl(
        req,
        job.videoUrl
      ),

    error:
      job.error
  };
}

// ============================================================
// PHYSICS-DIRECTED PROMPT
// ============================================================

function buildPhysicsDirectedPrompt(
  userPrompt
) {
  return `
PHYSICS-DIRECTED VIDEO SPECIFICATION:

Create the scene as one continuous, physically coherent 12-second shot. Treat gravity, mass, inertia, friction, collision response, contact forces and momentum as real constraints. Every moving object must remain supported by visible geometry or a continuous fluid/particle path. No floating, teleporting, popping, clipping through surfaces, impossible acceleration, or unexplained direction changes. Keep object dimensions, material properties and relative positions consistent from frame to frame. Rolling objects should visibly rotate in proportion to their travel distance and should roll without slipping when traction permits. Impacts must show believable momentum transfer, contact deformation or rebound, and small secondary vibrations when appropriate. Mechanical parts must remain meshed and driven by their contacts. Camera is locked unless motion is explicitly requested. Prioritize temporal consistency, stable geometry and realistic motion over decorative effects.

USER CREATIVE BRIEF:

${userPrompt.trim()}
`.trim();
}

// ============================================================
// DOWNLOAD VIDEO
// ============================================================

async function downloadFile(
  url,
  target
) {
  console.log(
    `[download] Starting download: ${url}`
  );

  const response =
    await axios.get(
      url,
      {
        responseType:
          'stream',

        timeout:
          120000,

        maxRedirects:
          5,

        headers: {
          'User-Agent':
            'AI-Blender-Video-Maker/1.0'
        }
      }
    );

  await new Promise(
    (resolve, reject) => {
      const out =
        fs.createWriteStream(
          target
        );

      response.data.pipe(
        out
      );

      response.data.on(
        'error',
        reject
      );

      out.on(
        'error',
        reject
      );

      out.on(
        'finish',
        resolve
      );
    }
  );

  const stat =
    await fsp.stat(
      target
    );

  if (
    !stat.isFile() ||
    stat.size <= 0
  ) {
    throw new Error(
      'Downloaded video file is empty.'
    );
  }

  console.log(
    `[download] Video saved: ${target}`
  );

  console.log(
    `[download] File size: ${stat.size} bytes`
  );
}

// ============================================================
// SAVE GENERATED VIDEO
// ============================================================
//
// NO WATERMARK
// NO FFMPEG
// NO SHARP
// NO DRAWTEXT
//
// Agnes generated video is downloaded directly.
// ============================================================

async function saveGeneratedVideo(
  sourceUrl,
  jobId
) {
  const outputName =
    `${jobId}.mp4`;

  const outputPath =
    path.join(
      GENERATED_DIR,
      outputName
    );

  await downloadFile(
    sourceUrl,
    outputPath
  );

  const stat =
    await fsp.stat(
      outputPath
    );

  if (
    !stat.isFile() ||
    stat.size <= 0
  ) {
    throw new Error(
      'Final generated video is empty or invalid.'
    );
  }

  return {
    outputPath,

    videoUrl:
      `/generated/${outputName}`
  };
}

// ============================================================
// GENERATE VIDEO
// ============================================================

app.post(
  '/api/generate',
  async (
    req,
    res
  ) => {

    const prompt =
      typeof req.body?.prompt ===
      'string'
        ? req.body.prompt.trim()
        : '';

    // --------------------------------------------------------
    // Validate prompt
    // --------------------------------------------------------

    if (!prompt) {
      return res
        .status(400)
        .json({
          error:
            'Prompt cannot be empty.'
        });
    }

    // --------------------------------------------------------
    // Check API key
    // --------------------------------------------------------

    if (
      !process.env.AGNES_API_KEY
    ) {
      return res
        .status(500)
        .json({
          error:
            'Server is missing AGNES_API_KEY. Add it to backend/.env and restart.'
        });
    }

    try {

      console.log(
        '========================================'
      );

      console.log(
        '[generate] Starting video generation'
      );

      console.log(
        '[generate] Prompt:',
        prompt
      );

      // ------------------------------------------------------
      // Create Agnes task
      // ------------------------------------------------------

      const task =
        await createVideoTask(
          buildPhysicsDirectedPrompt(
            prompt
          )
        );

      console.log(
        '[generate] Agnes task:',
        JSON.stringify(
          task,
          null,
          2
        )
      );

      // ------------------------------------------------------
      // Create local job
      // ------------------------------------------------------

      const jobId =
        crypto.randomUUID();

      const now =
        Date.now();

      jobs.set(
        jobId,
        {
          jobId,

          prompt,

          agnesTaskId:
            task.taskId,

          agnesVideoId:
            task.videoId,

          status:
            mapStatus(
              task.status
            ),

          progress:
            task.progress,

          videoUrl:
            null,

          sourceVideoUrl:
            null,

          error:
            null,

          createdAt:
            now,

          nextAgnesCheckAt:
            now
        }
      );

      console.log(
        '[generate] Job ID:',
        jobId
      );

      console.log(
        '[generate] Status:',
        mapStatus(
          task.status
        )
      );

      console.log(
        '========================================'
      );

      return res
        .status(201)
        .json({
          jobId,

          status:
            mapStatus(
              task.status
            )
        });

    } catch (err) {

      console.error(
        '[generate] Agnes AI error:',
        err
      );

      const status =
        err.status === 429
          ? 429
          : err.status &&
            err.status < 500
          ? err.status
          : 502;

      return res
        .status(status)
        .json({
          error:
            err.message,

          retryAfter:
            err.retryAfter
        });
    }
  }
);

// ============================================================
// VIDEO STATUS
// ============================================================

app.get(
  '/api/status/:jobId',
  async (
    req,
    res
  ) => {

    const job =
      jobs.get(
        req.params.jobId
      );

    // --------------------------------------------------------
    // Unknown job
    // --------------------------------------------------------

    if (!job) {
      return res
        .status(404)
        .json({
          error:
            'Unknown job ID. It may have expired — try generating again.'
        });
    }

    // --------------------------------------------------------
    // Already completed
    // --------------------------------------------------------

    if (
      job.status ===
        'completed' &&
      job.videoUrl
    ) {
      return res.json(
        toClientResponse(
          job,
          req
        )
      );
    }

    // --------------------------------------------------------
    // Already failed
    // --------------------------------------------------------

    if (
      job.status ===
      'failed'
    ) {
      return res.json(
        toClientResponse(
          job,
          req
        )
      );
    }

    // --------------------------------------------------------
    // Timeout protection
    // --------------------------------------------------------

    if (
      Date.now() -
        job.createdAt >
      JOB_TIMEOUT_MS
    ) {

      job.status =
        'failed';

      job.error =
        'Video generation timed out after 5 minutes.';

      console.error(
        `[status] Timeout: ${job.jobId}`
      );

      return res.json(
        toClientResponse(
          job,
          req
        )
      );
    }

    // --------------------------------------------------------
    // Wait until next Agnes poll
    // --------------------------------------------------------

    if (
      Date.now() <
      job.nextAgnesCheckAt
    ) {
      return res.json(
        toClientResponse(
          job,
          req
        )
      );
    }

    try {

      // ------------------------------------------------------
      // Get Agnes status
      // ------------------------------------------------------

      const result =
        await getVideoStatus({
          videoId:
            job.agnesVideoId,

          taskId:
            job.agnesTaskId
        });

      console.log(
        `[status] ${job.jobId}:`,
        JSON.stringify(
          result,
          null,
          2
        )
      );

      // ------------------------------------------------------
      // Schedule next poll
      // ------------------------------------------------------

      job.nextAgnesCheckAt =
        Date.now() +
        AGNES_POLL_INTERVAL_MS;

      // ------------------------------------------------------
      // Update status
      // ------------------------------------------------------

      job.status =
        mapStatus(
          result.status
        );

      job.progress =
        result.progress;

      // ======================================================
      // VIDEO COMPLETED
      // ======================================================

      if (
        result.status ===
        'completed'
      ) {

        console.log(
          '[video] Agnes reports COMPLETED.'
        );

        console.log(
          '[video] Agnes video URL:',
          result.videoUrl
        );

        // ----------------------------------------------------
        // Completed but URL not available yet
        // ----------------------------------------------------

        if (
          !result.videoUrl
        ) {

          console.warn(
            '[video] Agnes says completed but returned no video URL.'
          );

          console.warn(
            '[video] Will retry status request.'
          );

          job.status =
            'processing';

          job.progress =
            95;

          job.error =
            null;

          // Retry after 5 seconds
          job.nextAgnesCheckAt =
            Date.now() +
            5000;

          return res.json(
            toClientResponse(
              job,
              req
            )
          );
        }

        // ----------------------------------------------------
        // Store source URL
        // ----------------------------------------------------

        job.sourceVideoUrl =
          result.videoUrl;

        console.log(
          `[video] Agnes source video: ${result.videoUrl}`
        );

        // ----------------------------------------------------
        // Download final video
        // ----------------------------------------------------

        try {

          const saved =
            await saveGeneratedVideo(
              result.videoUrl,
              job.jobId
            );

          // ----------------------------------------------
          // Store generated URL
          // ----------------------------------------------

          job.videoUrl =
            saved.videoUrl;

          job.status =
            'completed';

          job.progress =
            100;

          job.error =
            null;

          console.log(
            `[video] Final video ready: ${job.videoUrl}`
          );

          console.log(
            `[video] Source video: ${job.sourceVideoUrl}`
          );

        } catch (
          downloadErr
        ) {

          console.error(
            '[video] Download error:',
            downloadErr
          );

          job.status =
            'failed';

          job.error =
            `Video was generated, but downloading the final video failed: ${downloadErr.message}`;

          return res.json(
            toClientResponse(
              job,
              req
            )
          );
        }
      }

      // ======================================================
      // AGNES FAILED
      // ======================================================

      if (
        result.status ===
        'failed'
      ) {

        job.status =
          'failed';

        job.error =
          (
            result.error &&
            (
              result.error.message ||
              (
                typeof result.error ===
                'string'
                  ? result.error
                  : JSON.stringify(
                      result.error
                    )
              )
            )
          ) ||
          'Video generation failed on Agnes AI.';

        console.error(
          '[video] Agnes generation failed:',
          job.error
        );
      }

      // ------------------------------------------------------
      // Return status
      // ------------------------------------------------------

      return res.json(
        toClientResponse(
          job,
          req
        )
      );

    } catch (err) {

      console.error(
        '[status] Agnes AI error:',
        err
      );

      // ------------------------------------------------------
      // Permanent errors
      // ------------------------------------------------------

      if (
        err.status === 404 ||
        err.status === 401 ||
        err.status === 403
      ) {

        job.status =
          'failed';

        job.error =
          err.message;

        return res.json(
          toClientResponse(
            job,
            req
          )
        );
      }

      // ------------------------------------------------------
      // Temporary errors
      // ------------------------------------------------------

      const backoffMs =
        err.status === 429
          ? Math.max(
              (
                err.retryAfter ||
                0
              ) * 1000,

              AGNES_RATE_LIMIT_BACKOFF_MS
            )
          : AGNES_POLL_INTERVAL_MS;

      job.nextAgnesCheckAt =
        Date.now() +
        backoffMs;

      return res.json(
        toClientResponse(
          job,
          req
        )
      );
    }
  }
);

// ============================================================
// CONFIG
// ============================================================

app.get(
  '/api/config',
  (
    _req,
    res
  ) => {

    res.json({
      watermark:
        null,

      physicsDirected:
        true,

      finalVideoHasBurnedWatermark:
        false
    });
  }
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  '/api/health',
  (
    _req,
    res
  ) => {

    res.json({
      ok:
        true,

      service:
        'ai-blender-video-maker',

      watermark:
        false,

      timestamp:
        new Date().toISOString()
    });
  }
);

// ============================================================
// PROMPT ROUTER
// ============================================================

app.use(
  '/api/prompt',
  promptRouter
);

// ============================================================
// 404
// ============================================================

app.use(
  (
    req,
    res
  ) => {

    res
      .status(404)
      .json({
        error:
          'Not found.'
      });
  }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      `✅ Text-to-Video backend running on http://localhost:${PORT}`
    );

    console.log(
      `🎬 Physics-directed generation: ON`
    );

    console.log(
      `⏱️ Target video duration: ~12 seconds`
    );

    console.log(
      `🎞️ FPS: 24`
    );

    console.log(
      `🔖 Watermark: DISABLED`
    );

    console.log(
      `📁 Generated videos: ${GENERATED_DIR}`
    );

    if (
      !process.env.AGNES_API_KEY
    ) {

      console.warn(
        '⚠️ AGNES_API_KEY is not set — add it to backend/.env before generating videos.'
      );
    }

    logPromptStartupState();
  }
);