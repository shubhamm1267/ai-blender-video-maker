/**
 * Thin wrapper around the Agnes AI video generation API.
 *
 * Docs (as of writing):
 *   Create task : POST https://apihub.agnes-ai.com/v1/videos
 *   Poll status : GET  https://apihub.agnes-ai.com/agnesapi?video_id=<id>&model_name=agnes-video-v2.0
 *   Legacy poll : GET  https://apihub.agnes-ai.com/v1/videos/<task_id>
 *
 * Auth: "Authorization: Bearer <AGNES_API_KEY>"
 * Free plan: video model is limited to 1 request/minute for task creation.
 *
 * Note: the "completed" result's video URL is returned under an inconsistently
 * named field depending on gateway version (video_url, url, or the oddly-named
 * remixed_from_video_id). We defensively check all three.
 */

const axios = require('axios');

const AGNES_ROOT = 'https://apihub.agnes-ai.com';
const AGNES_V1 = `${AGNES_ROOT}/v1`;
const AGNES_STATUS_URL = `${AGNES_ROOT}/agnesapi`;
const MODEL = 'agnes-video-v2.0';
const REQUEST_TIMEOUT_MS = 30000;

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.AGNES_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Creates an async video generation task on Agnes AI.
 * @param {string} prompt
 * @returns {Promise<{taskId: string, videoId: string, status: string, progress: number}>}
 */
async function createVideoTask(prompt) {
  try {
    const { data } = await axios.post(
      `${AGNES_V1}/videos`,
      {
        model: MODEL,
        prompt,
        // ~5 second clip. Keep a stable 24 fps timeline so motion can be
        // described consistently and the post-processing pipeline stays deterministic.
        width: 1152,
        height: 768,
        num_frames: 121,
        frame_rate: 24,
      },
      { headers: authHeaders(), timeout: REQUEST_TIMEOUT_MS }
    );

    return {
      taskId: data.task_id || data.id,
      videoId: data.video_id,
      status: data.status || 'queued',
      progress: typeof data.progress === 'number' ? data.progress : 0,
    };
  } catch (err) {
    throw toAgnesError(err);
  }
}

/**
 * Polls Agnes AI for the current status of a video task.
 * @param {{videoId?: string, taskId?: string}} ids
 * @returns {Promise<{status: string, progress: number, videoUrl: string|null, error: any}>}
 */
async function getVideoStatus({ videoId, taskId }) {
  try {
    let data;

    if (videoId) {
      const res = await axios.get(AGNES_STATUS_URL, {
        params: { video_id: videoId, model_name: MODEL },
        headers: { Authorization: `Bearer ${process.env.AGNES_API_KEY}` },
        timeout: REQUEST_TIMEOUT_MS,
      });
      data = res.data;
    } else if (taskId) {
      const res = await axios.get(`${AGNES_V1}/videos/${taskId}`, {
        headers: { Authorization: `Bearer ${process.env.AGNES_API_KEY}` },
        timeout: REQUEST_TIMEOUT_MS,
      });
      data = res.data;
    } else {
      throw new Error('No video ID or task ID available to poll.');
    }

    const status = data.status || 'in_progress';
    const videoUrl =
      status === 'completed'
        ? data.video_url || data.url || data.remixed_from_video_id || null
        : null;

    return {
      status,
      progress: typeof data.progress === 'number' ? data.progress : 0,
      videoUrl,
      error: data.error || null,
    };
  } catch (err) {
    throw toAgnesError(err);
  }
}

/**
 * Normalizes axios/Agnes errors into a friendly Error with an HTTP-ish status
 * and, for 429s, a retryAfter hint (seconds).
 */
function toAgnesError(err) {
  if (err.response) {
    const status = err.response.status;
    const retryAfterHeader = err.response.headers ? err.response.headers['retry-after'] : undefined;
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : status === 429 ? 60 : undefined;

    const messages = {
      400: 'Agnes AI rejected the request — check the prompt and parameters.',
      401: 'Agnes AI authentication failed. Check AGNES_API_KEY in backend/.env.',
      403: 'Agnes AI authentication failed. Check AGNES_API_KEY in backend/.env.',
      404: 'Video task not found on Agnes AI (it may have expired).',
      429: `Agnes AI rate limit reached — the free plan allows 1 video request per minute.${
        retryAfter ? ` Try again in ${retryAfter}s.` : ' Please wait a minute and try again.'
      }`,
      500: 'Agnes AI had a server error. Please try again shortly.',
      503: 'Agnes AI is busy right now. Please try again shortly.',
    };

    const message = messages[status] || `Agnes AI request failed (HTTP ${status}).`;
    const error = new Error(message);
    error.status = status;
    error.retryAfter = retryAfter;
    error.details = err.response.data;
    return error;
  }

  if (err.code === 'ECONNABORTED') {
    const error = new Error('Agnes AI request timed out.');
    error.status = 504;
    return error;
  }

  const error = new Error('Could not reach Agnes AI. Check your network connection.');
  error.status = 502;
  return error;
}

module.exports = { createVideoTask, getVideoStatus, MODEL };
