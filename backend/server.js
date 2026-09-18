const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '.env'),
});

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const axios = require('axios');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const sharp = require('sharp');

const {
  createVideoTask,
  getVideoStatus,
} = require('./agnes-video');

const {
  promptRouter,
  logPromptStartupState,
} = require('./prompt-routes');

const app = express();

const PORT = process.env.PORT || 3000;

const JOB_TIMEOUT_MS =
  5 * 60 * 1000;

const AGNES_POLL_INTERVAL_MS =
  20 * 1000;

const AGNES_RATE_LIMIT_BACKOFF_MS =
  60 * 1000;

const GENERATED_DIR =
  path.join(os.tmpdir(), 'generated');

const WATERMARK_TEXT = (
  process.env.CHANNEL_WATERMARK ||
  'MarbleVortex3D'
).trim();

const WATERMARK_OPACITY = Math.min(
  1,
  Math.max(
    0.15,
    Number(
      process.env.WATERMARK_OPACITY || 0.72
    )
  )
);

fs.mkdirSync(
  GENERATED_DIR,
  {
    recursive: true,
  }
);

/*
 * Middleware
 */

app.use(cors());

app.use(
  express.json({
    limit: '2mb',
  })
);

/*
 * Serve generated videos.
 */
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
      },
    }
  )
);

const jobs = new Map();

/*
 * Map Agnes status to frontend status.
 */
function mapStatus(
  agnesStatus
) {
  switch (agnesStatus) {
    case 'queued':
      return 'pending';

    case 'in_progress':
      return 'processing';

    case 'completed':
      return 'completed';

    case 'failed':
      return 'failed';

    default:
      return 'processing';
  }
}

/*
 * Convert relative generated URL
 * into an absolute backend URL.
 *
 * Example:
 *
 * /generated/abc.mp4
 *
 * becomes:
 *
 * http://localhost:3000/generated/abc.mp4
 *
 * or:
 *
 * https://your-project.vercel.app/generated/abc.mp4
 */
function makeAbsoluteVideoUrl(
  req,
  videoUrl
) {
  if (!videoUrl) {
    return null;
  }

  if (
    videoUrl.startsWith('http://') ||
    videoUrl.startsWith('https://')
  ) {
    return videoUrl;
  }

  const protocol =
    req.headers['x-forwarded-proto'] ||
    req.protocol;

  const host =
    req.get('host');

  return `${protocol}://${host}${videoUrl}`;
}

/*
 * Response sent to frontend.
 */
function toClientResponse(
  job,
  req
) {
  return {
    jobId: job.jobId,

    status: job.status,

    progress: job.progress,

    videoUrl:
      makeAbsoluteVideoUrl(
        req,
        job.videoUrl
      ),

    error: job.error,
  };
}

/*
 * Physics-directed prompt.
 */
function buildPhysicsDirectedPrompt(
  userPrompt
) {
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

/*
 * Escape text for SVG.
 */
function escapeXml(
  value
) {
  return String(value)
    .replace(
      /&/g,
      '&amp;'
    )
    .replace(
      /</g,
      '&lt;'
    )
    .replace(
      />/g,
      '&gt;'
    )
    .replace(
      /"/g,
      '&quot;'
    )
    .replace(
      /'/g,
      '&apos;'
    );
}

/*
 * Download Agnes video.
 */
async function downloadFile(
  url,
  target
) {
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
            'MarbleVortex3D-LocalVideoRenderer/1.0',
        },
      }
    );

  await new Promise(
    (
      resolve,
      reject
    ) => {
      const out =
        fs.createWriteStream(
          target
        );

      response.data.pipe(out);

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

  /*
   * Verify downloaded source.
   */
  if (!fs.existsSync(target)) {
    throw new Error(
      'Source video download completed but file was not created.'
    );
  }

  const stats =
    await fsp.stat(
      target
    );

  if (stats.size === 0) {
    throw new Error(
      'Downloaded source video is empty.'
    );
  }

  console.log(
    `[download] Source video size: ${stats.size} bytes`
  );
}

/*
 * Create watermark PNG.
 *
 * We do NOT use FFmpeg drawtext.
 *
 * DejaVuSans.ttf is bundled inside:
 *
 * backend/fonts/DejaVuSans.ttf
 */
async function createWatermarkImage(
  outputPath
) {
  const text =
    escapeXml(
      WATERMARK_TEXT
    );

  const fontPath =
    path.join(
      __dirname,
      'fonts',
      'DejaVuSans.ttf'
    );

  if (
    !fs.existsSync(
      fontPath
    )
  ) {
    throw new Error(
      `Watermark font not found: ${fontPath}`
    );
  }

  const fontBase64 =
    fs
      .readFileSync(
        fontPath
      )
      .toString(
        'base64'
      );

  const svg = `
    <svg
      width="500"
      height="70"
      xmlns="http://www.w3.org/2000/svg"
    >

      <defs>

        <style>

          @font-face {
            font-family: 'DejaVuSans';

            src:
              url(data:font/ttf;base64,${fontBase64});
          }

          .watermark {
            font-family: 'DejaVuSans';
            font-size: 28px;
            font-weight: normal;
          }

        </style>

      </defs>

      <!-- Shadow -->

      <text
        x="10"
        y="42"
        class="watermark"
        fill="black"
        fill-opacity="0.35"
        transform="translate(2,2)"
      >${text}</text>

      <!-- Main watermark -->

      <text
        x="10"
        y="42"
        class="watermark"
        fill="white"
        fill-opacity="${WATERMARK_OPACITY}"
      >${text}</text>

    </svg>
  `;

  await sharp(
    Buffer.from(svg)
  )
    .png()
    .toFile(
      outputPath
    );

  /*
   * Verify watermark PNG.
   */
  if (
    !fs.existsSync(
      outputPath
    )
  ) {
    throw new Error(
      'Watermark PNG was not created.'
    );
  }

  const stats =
    await fsp.stat(
      outputPath
    );

  if (stats.size === 0) {
    throw new Error(
      'Watermark PNG is empty.'
    );
  }

  console.log(
    `[watermark] PNG created: ${stats.size} bytes`
  );
}

/*
 * Burn watermark PNG onto video.
 *
 * IMPORTANT:
 * No drawtext.
 *
 * Explicit video/audio mapping is used.
 */
function burnWatermark(
  inputPath,
  outputPath,
  watermarkPath
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      const filter =
        '[0:v][1:v]overlay=W-w-32:H-h-28[v]';

      const args = [
        '-y',

        /*
         * Source video.
         */
        '-i',
        inputPath,

        /*
         * Watermark PNG.
         */
        '-i',
        watermarkPath,

        /*
         * Overlay watermark.
         */
        '-filter_complex',
        filter,

        /*
         * Explicitly select
         * watermarked video.
         */
        '-map',
        '[v]',

        /*
         * Keep original audio
         * if audio exists.
         */
        '-map',
        '0:a?',

        /*
         * Video codec.
         */
        '-c:v',
        'libx264',

        '-preset',
        'medium',

        '-crf',
        '18',

        /*
         * Audio codec.
         */
        '-c:a',
        'aac',

        '-b:a',
        '192k',

        /*
         * MP4 optimization.
         */
        '-movflags',
        '+faststart',

        outputPath,
      ];

      console.log(
        '[ffmpeg] Starting watermark render...'
      );

      console.log(
        '[ffmpeg] Input:',
        inputPath
      );

      console.log(
        '[ffmpeg] Watermark:',
        watermarkPath
      );

      console.log(
        '[ffmpeg] Output:',
        outputPath
      );

      const child =
        spawn(
          ffmpegPath,
          args,
          {
            windowsHide:
              true,
          }
        );

      let stderr = '';

      child.stderr.on(
        'data',
        (data) => {
          const message =
            data.toString();

          stderr += message;

          console.log(
            '[ffmpeg]',
            message
          );
        }
      );

      child.on(
        'error',
        (err) => {
          reject(err);
        }
      );

      child.on(
        'close',
        (code) => {
          if (
            code !== 0
          ) {
            reject(
              new Error(
                `FFmpeg watermark render failed (exit ${code}). ${stderr.slice(
                  -2000
                )}`
              )
            );

            return;
          }

          /*
           * FFmpeg says success.
           * Now verify actual MP4.
           */
          if (
            !fs.existsSync(
              outputPath
            )
          ) {
            reject(
              new Error(
                'FFmpeg completed successfully, but output video file was not created.'
              )
            );

            return;
          }

          const stats =
            fs.statSync(
              outputPath
            );

          if (
            stats.size === 0
          ) {
            reject(
              new Error(
                'FFmpeg created an empty output video.'
              )
            );

            return;
          }

          console.log(
            `[ffmpeg] Watermark render completed successfully.`
          );

          console.log(
            `[ffmpeg] Output video size: ${stats.size} bytes`
          );

          resolve();
        }
      );
    }
  );
}

/*
 * Full watermark rendering pipeline.
 */
async function renderWatermarkedVideo(
  sourceUrl,
  jobId
) {
  const workDir =
    await fsp.mkdtemp(
      path.join(
        os.tmpdir(),
        'marblevortex3d-'
      )
    );

  const inputPath =
    path.join(
      workDir,
      'source.mp4'
    );

  const watermarkPath =
    path.join(
      workDir,
      'watermark.png'
    );

  const outputName =
    `${jobId}.mp4`;

  const outputPath =
    path.join(
      GENERATED_DIR,
      outputName
    );

  try {
    console.log(
      `[render] Downloading source video for ${jobId}...`
    );

    await downloadFile(
      sourceUrl,
      inputPath
    );

    console.log(
      `[render] Creating watermark PNG for ${jobId}...`
    );

    await createWatermarkImage(
      watermarkPath
    );

    console.log(
      `[render] Applying watermark overlay for ${jobId}...`
    );

    await burnWatermark(
      inputPath,
      outputPath,
      watermarkPath
    );

    /*
     * Final verification.
     */
    if (
      !fs.existsSync(
        outputPath
      )
    ) {
      throw new Error(
        'Final watermarked video was not created.'
      );
    }

    const outputStats =
      await fsp.stat(
        outputPath
      );

    if (
      outputStats.size === 0
    ) {
      throw new Error(
        'Final watermarked video is empty.'
      );
    }

    console.log(
      `[render] Final video created: ${outputPath}`
    );

    console.log(
      `[render] Final video size: ${outputStats.size} bytes`
    );

    /*
     * Return relative path internally.
     * It will be converted to absolute URL
     * before sending to frontend.
     */
    return `/generated/${outputName}`;
  } finally {
    await fsp.rm(
      workDir,
      {
        recursive:
          true,

        force:
          true,
      }
    ).catch(
      () => {}
    );
  }
}

/*
 * Generate video.
 */
app.post(
  '/api/generate',
  async (
    req,
    res
  ) => {
    const prompt =
      typeof req.body?.prompt === 'string'
        ? req.body.prompt.trim()
        : '';

    if (!prompt) {
      return res.status(400).json({
        error:
          'Prompt cannot be empty.',
      });
    }

    if (
      !process.env.AGNES_API_KEY
    ) {
      return res.status(500).json({
        error:
          'Server is missing AGNES_API_KEY. Add it to backend/.env and restart.',
      });
    }

    try {
      const task =
        await createVideoTask(
          buildPhysicsDirectedPrompt(
            prompt
          )
        );

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
            now,
        }
      );

      return res.status(201).json({
        jobId,

        status:
          mapStatus(
            task.status
          ),
      });
    } catch (err) {
      console.error(
        '[generate] Agnes AI error:',
        err.message
      );

      const status =
        err.status === 429
          ? 429
          : err.status &&
            err.status < 500
            ? err.status
            : 502;

      return res.status(
        status
      ).json({
        error:
          err.message,

        retryAfter:
          err.retryAfter,
      });
    }
  }
);

/*
 * Check video status.
 */
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

    if (!job) {
      return res.status(404).json({
        error:
          'Unknown job ID. It may have expired — try generating again.',
      });
    }

    /*
     * Only report completed if
     * a final video URL exists.
     */
    if (
      job.status === 'completed'
    ) {
      if (
        job.videoUrl
      ) {
        return res.json(
          toClientResponse(
            job,
            req
          )
        );
      }

      job.status =
        'failed';

      job.error =
        'Video generation completed, but the final video URL was not created.';

      return res.json(
        toClientResponse(
          job,
          req
        )
      );
    }

    if (
      job.status === 'failed'
    ) {
      return res.json(
        toClientResponse(
          job,
          req
        )
      );
    }

    /*
     * Overall timeout.
     */
    if (
      Date.now() -
        job.createdAt >
      JOB_TIMEOUT_MS
    ) {
      job.status =
        'failed';

      job.error =
        'Video generation timed out after 5 minutes.';

      return res.json(
        toClientResponse(
          job,
          req
        )
      );
    }

    /*
     * Respect polling interval.
     */
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
      const result =
        await getVideoStatus({
          videoId:
            job.agnesVideoId,

          taskId:
            job.agnesTaskId,
        });

      job.nextAgnesCheckAt =
        Date.now() +
        AGNES_POLL_INTERVAL_MS;

      job.progress =
        result.progress;

      /*
       * Agnes completed.
       */
      if (
        result.status === 'completed'
      ) {
        /*
         * Agnes must provide
         * a source video URL.
         */
        if (
          !result.videoUrl
        ) {
          job.status =
            'failed';

          job.error =
            'Agnes reported the video as completed, but no source video URL was returned.';

          return res.json(
            toClientResponse(
              job,
              req
            )
          );
        }

        job.status =
          'processing';

        job.progress =
          95;

        job.sourceVideoUrl =
          result.videoUrl;

        try {
          console.log(
            `[render] Burning ${WATERMARK_TEXT} watermark into ${job.jobId}...`
          );

          job.videoUrl =
            await renderWatermarkedVideo(
              result.videoUrl,
              job.jobId
            );

          /*
           * Only NOW mark completed.
           */
          job.progress =
            100;

          job.status =
            'completed';

          console.log(
            `[render] Job ${job.jobId} completed successfully.`
          );

          console.log(
            `[render] Video URL: ${job.videoUrl}`
          );
        } catch (
          renderErr
        ) {
          console.error(
            '[render] Watermark error:',
            renderErr.message
          );

          job.status =
            'failed';

          job.error =
            `Video was generated, but the final watermark render failed: ${renderErr.message}`;

          return res.json(
            toClientResponse(
              job,
              req
            )
          );
        }
      } else {
        /*
         * Agnes still processing.
         */
        job.status =
          mapStatus(
            result.status
          );
      }

      /*
       * Agnes itself failed.
       */
      if (
        result.status === 'failed'
      ) {
        job.status =
          'failed';

        job.error =
          (
            result.error &&
            (
              result.error.message ||
              JSON.stringify(
                result.error
              )
            )
          ) ||
          'Video generation failed on Agnes AI.';
      }

      return res.json(
        toClientResponse(
          job,
          req
        )
      );
    } catch (
      err
    ) {
      console.error(
        '[status] Agnes AI error:',
        err.message
      );

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

      const backoffMs =
        err.status === 429
          ? Math.max(
              (err.retryAfter || 0) *
                1000,
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

/*
 * Backend configuration.
 */
app.get(
  '/api/config',
  (
    _req,
    res
  ) => {
    res.json({
      watermark:
        WATERMARK_TEXT,

      physicsDirected:
        true,

      finalVideoHasBurnedWatermark:
        true,
    });
  }
);

/*
 * Prompt API.
 */
app.use(
  '/api/prompt',
  promptRouter
);

/*
 * 404 handler.
 */
app.use(
  (
    req,
    res
  ) =>
    res.status(404).json({
      error:
        'Not found.',
    })
);

/*
 * Start server.
 */
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
      `🔖 Burned-in watermark: ${WATERMARK_TEXT}`
    );

    console.log(
      `🎨 Watermark font: DejaVuSans.ttf`
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