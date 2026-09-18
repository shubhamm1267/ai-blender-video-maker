const axios = require('axios');

const AGNES_ROOT = 'https://apihub.agnes-ai.com';
const AGNES_V1 = `${AGNES_ROOT}/v1`;
const AGNES_STATUS_URL = `${AGNES_ROOT}/agnesapi`;

// Agnes Video v2.0
const MODEL = 'agnes-video-v2.0';

const REQUEST_TIMEOUT_MS = 30000;

// ============================================================
// VIDEO SETTINGS
// ============================================================

// 1152 x 768 resolution
const VIDEO_WIDTH = 1152;
const VIDEO_HEIGHT = 768;

// 289 frames at 24 FPS
// 289 / 24 = 12.04 seconds
const VIDEO_FRAMES = 289;
const VIDEO_FPS = 24;

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.AGNES_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// ============================================================
// CREATE VIDEO TASK
// ============================================================

async function createVideoTask(prompt) {
  try {
    const requestBody = {
      model: MODEL,
      prompt: prompt,

      // Video resolution
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,

      // Approximately 12 seconds
      num_frames: VIDEO_FRAMES,

      // Keep normal 24 FPS
      frame_rate: VIDEO_FPS,
    };

    console.log('========================================');
    console.log('Agnes Video Request');
    console.log('========================================');
    console.log('Model:', MODEL);
    console.log(
      'Resolution:',
      `${VIDEO_WIDTH}x${VIDEO_HEIGHT}`
    );
    console.log('Frames:', VIDEO_FRAMES);
    console.log('FPS:', VIDEO_FPS);
    console.log(
      'Expected duration:',
      `${(VIDEO_FRAMES / VIDEO_FPS).toFixed(2)} seconds`
    );
    console.log('========================================');

    const { data } = await axios.post(
      `${AGNES_V1}/videos`,
      requestBody,
      {
        headers: authHeaders(),
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    console.log('Agnes create response:', data);

    return {
      taskId: data.task_id || data.id || null,
      videoId: data.video_id || null,
      status: data.status || 'queued',
      progress:
        typeof data.progress === 'number'
          ? data.progress
          : 0,
    };
  } catch (err) {
    throw toAgnesError(err);
  }
}

// ============================================================
// GET VIDEO STATUS
// ============================================================

async function getVideoStatus({ videoId, taskId }) {
  try {
    let data;

    // --------------------------------------------------------
    // Poll using video_id
    // --------------------------------------------------------

    if (videoId) {
      const res = await axios.get(
        AGNES_STATUS_URL,
        {
          params: {
            video_id: videoId,
            model_name: MODEL,
          },
          headers: {
            Authorization: `Bearer ${process.env.AGNES_API_KEY}`,
          },
          timeout: REQUEST_TIMEOUT_MS,
        }
      );

      data = res.data;
    }

    // --------------------------------------------------------
    // Fallback: poll using task_id
    // --------------------------------------------------------

    else if (taskId) {
      const res = await axios.get(
        `${AGNES_V1}/videos/${taskId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.AGNES_API_KEY}`,
          },
          timeout: REQUEST_TIMEOUT_MS,
        }
      );

      data = res.data;
    }

    else {
      throw new Error(
        'No video ID or task ID available to poll.'
      );
    }

    console.log('Agnes status response:', data);

    const status = data.status || 'in_progress';

    // --------------------------------------------------------
    // Get completed video URL
    // --------------------------------------------------------

    const videoUrl =
      status === 'completed'
        ? data.video_url ||
          data.url ||
          data.remixed_from_video_id ||
          null
        : null;

    return {
      status: status,

      progress:
        typeof data.progress === 'number'
          ? data.progress
          : 0,

      videoUrl: videoUrl,

      error: data.error || null,
    };
  } catch (err) {
    throw toAgnesError(err);
  }
}

// ============================================================
// ERROR HANDLING
// ============================================================

function toAgnesError(err) {
  // --------------------------------------------------------
  // Agnes HTTP error
  // --------------------------------------------------------

  if (err.response) {
    const status = err.response.status;

    const retryAfterHeader =
      err.response.headers
        ? err.response.headers['retry-after']
        : undefined;

    const retryAfter = retryAfterHeader
      ? Number(retryAfterHeader)
      : status === 429
      ? 60
      : undefined;

    const messages = {
      400:
        'Agnes AI rejected the request — check the prompt and video parameters.',

      401:
        'Agnes AI authentication failed. Check AGNES_API_KEY in backend/.env.',

      403:
        'Agnes AI authentication failed. Check AGNES_API_KEY in backend/.env.',

      404:
        'Video task not found on Agnes AI (it may have expired).',

      429:
        `Agnes AI rate limit reached — please wait ${
          retryAfter || 60
        } seconds before creating another video.`,

      500:
        'Agnes AI had a server error. Please try again shortly.',

      503:
        'Agnes AI is busy right now. Please wait and try again shortly.',
    };

    const message =
      messages[status] ||
      `Agnes AI request failed (HTTP ${status}).`;

    const error = new Error(message);

    error.status = status;
    error.retryAfter = retryAfter;
    error.details = err.response.data;

    return error;
  }

  // --------------------------------------------------------
  // Request timeout
  // --------------------------------------------------------

  if (err.code === 'ECONNABORTED') {
    const error = new Error(
      'Agnes AI request timed out.'
    );

    error.status = 504;

    return error;
  }

  // --------------------------------------------------------
  // Network / unknown error
  // --------------------------------------------------------

  const error = new Error(
    'Could not reach Agnes AI. Check your network connection.'
  );

  error.status = 502;

  return error;
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  createVideoTask,
  getVideoStatus,
  MODEL,
};