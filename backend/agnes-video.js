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

const VIDEO_WIDTH = 1152;
const VIDEO_HEIGHT = 768;

// 289 / 24 = 12.04 seconds
const VIDEO_FRAMES = 289;
const VIDEO_FPS = 24;

// ============================================================
// AUTH
// ============================================================

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.AGNES_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// ============================================================
// FIND VIDEO URL
// ============================================================

function extractVideoUrl(data) {
  if (!data) {
    return null;
  }

  // ----------------------------------------------------------
  // Direct top-level fields
  // ----------------------------------------------------------

  const directCandidates = [
    data.video_url,
    data.url,
    data.videoUrl,
    data.output_url,
    data.outputUrl,
    data.download_url,
    data.downloadUrl,
    data.remixed_from_video_id,
  ];

  for (const value of directCandidates) {
    if (
      typeof value === 'string' &&
      /^https?:\/\//i.test(value)
    ) {
      return value;
    }
  }

  // ----------------------------------------------------------
  // Common nested response fields
  // ----------------------------------------------------------

  const nestedObjects = [
    data.data,
    data.result,
    data.output,
    data.video,
  ];

  for (const obj of nestedObjects) {
    if (!obj || typeof obj !== 'object') {
      continue;
    }

    const nestedCandidates = [
      obj.video_url,
      obj.url,
      obj.videoUrl,
      obj.output_url,
      obj.outputUrl,
      obj.download_url,
      obj.downloadUrl,
      obj.remixed_from_video_id,
    ];

    for (const value of nestedCandidates) {
      if (
        typeof value === 'string' &&
        /^https?:\/\//i.test(value)
      ) {
        return value;
      }
    }
  }

  // ----------------------------------------------------------
  // Recursive fallback
  // ----------------------------------------------------------

  const visited = new Set();

  function searchObject(obj) {
    if (!obj || typeof obj !== 'object') {
      return null;
    }

    if (visited.has(obj)) {
      return null;
    }

    visited.add(obj);

    for (const [key, value] of Object.entries(obj)) {
      if (
        typeof value === 'string' &&
        /^https?:\/\//i.test(value) &&
        (
          /video/i.test(key) ||
          /url/i.test(key) ||
          /output/i.test(key) ||
          /download/i.test(key)
        )
      ) {
        return value;
      }

      if (
        value &&
        typeof value === 'object'
      ) {
        const found = searchObject(value);

        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  return searchObject(data);
}

// ============================================================
// CREATE VIDEO TASK
// ============================================================

async function createVideoTask(prompt) {
  try {
    const requestBody = {
      model: MODEL,
      prompt: prompt,

      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,

      // Approximately 12 seconds
      num_frames: VIDEO_FRAMES,

      // Normal 24 FPS
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
      `${(
        VIDEO_FRAMES / VIDEO_FPS
      ).toFixed(2)} seconds`
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

    console.log(
      'Agnes create response:',
      JSON.stringify(
        data,
        null,
        2
      )
    );

    return {
      taskId:
        data.task_id ||
        data.id ||
        null,

      videoId:
        data.video_id ||
        null,

      status:
        data.status ||
        'queued',

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

async function getVideoStatus({
  videoId,
  taskId,
}) {
  try {
    let data;

    // --------------------------------------------------------
    // PRIMARY: Poll using video_id
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
            Authorization:
              `Bearer ${process.env.AGNES_API_KEY}`,
          },

          timeout:
            REQUEST_TIMEOUT_MS,
        }
      );

      data = res.data;
    }

    // --------------------------------------------------------
    // FALLBACK: Poll using task_id
    // --------------------------------------------------------

    else if (taskId) {
      const res = await axios.get(
        `${AGNES_V1}/videos/${taskId}`,
        {
          headers: {
            Authorization:
              `Bearer ${process.env.AGNES_API_KEY}`,
          },

          timeout:
            REQUEST_TIMEOUT_MS,
        }
      );

      data = res.data;
    }

    else {
      throw new Error(
        'No video ID or task ID available to poll.'
      );
    }

    // --------------------------------------------------------
    // RAW RESPONSE LOG
    // --------------------------------------------------------

    console.log(
      '========================================'
    );

    console.log(
      'Agnes status RAW response:'
    );

    console.log(
      JSON.stringify(
        data,
        null,
        2
      )
    );

    console.log(
      '========================================'
    );

    const status =
      data?.status ||
      data?.data?.status ||
      data?.result?.status ||
      'in_progress';

    // --------------------------------------------------------
    // VIDEO URL
    // --------------------------------------------------------

    let videoUrl = null;

    if (
      status === 'completed'
    ) {
      videoUrl =
        extractVideoUrl(data);

      console.log(
        '[Agnes] Extracted video URL:',
        videoUrl
      );

      if (!videoUrl) {
        console.error(
          '[Agnes] WARNING: Video completed but no video URL was found.'
        );
      }
    }

    // --------------------------------------------------------
    // PROGRESS
    // --------------------------------------------------------

    let progress = 0;

    if (
      status === 'completed'
    ) {
      progress = 100;
    } else if (
      typeof data?.progress === 'number'
    ) {
      progress = data.progress;
    } else if (
      typeof data?.data?.progress === 'number'
    ) {
      progress =
        data.data.progress;
    } else if (
      typeof data?.result?.progress === 'number'
    ) {
      progress =
        data.result.progress;
    }

    // --------------------------------------------------------
    // ERROR
    // --------------------------------------------------------

    const error =
      data?.error ||
      data?.data?.error ||
      data?.result?.error ||
      null;

    return {
      status,
      progress,
      videoUrl,
      error,
      raw: data,
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
    const status =
      err.response.status;

    const retryAfterHeader =
      err.response.headers
        ? err.response.headers[
            'retry-after'
          ]
        : undefined;

    const retryAfter =
      retryAfterHeader
        ? Number(
            retryAfterHeader
          )
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

    const error =
      new Error(message);

    error.status = status;
    error.retryAfter =
      retryAfter;

    error.details =
      err.response.data;

    return error;
  }

  // --------------------------------------------------------
  // Timeout
  // --------------------------------------------------------

  if (
    err.code ===
    'ECONNABORTED'
  ) {
    const error =
      new Error(
        'Agnes AI request timed out.'
      );

    error.status = 504;

    return error;
  }

  // --------------------------------------------------------
  // Network / unknown
  // --------------------------------------------------------

  const error =
    new Error(
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