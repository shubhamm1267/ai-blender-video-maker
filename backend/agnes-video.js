require('dotenv').config();

const axios = require('axios');

const AGNES_API_KEY = process.env.AGNES_API_KEY;

const AGNES_BASE_URL = 'https://apihub.agnes-ai.com';
const MODEL_NAME = 'agnes-video-v2.0';

const WIDTH = 1152;
const HEIGHT = 768;

// 289 / 24 = 12.04 seconds
const NUM_FRAMES = 289;
const FRAME_RATE = 24;

if (!AGNES_API_KEY) {
  console.warn('[Agnes] AGNES_API_KEY is not available.');
}

function extractVideoUrl(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const candidates = [
    data.url,
    data.video_url,
    data.videoUrl,
    data.output_url,
    data.outputUrl,
    data.download_url,
    data.downloadUrl,
    data.remixed_from_video_id,

    data.data?.url,
    data.data?.video_url,
    data.data?.videoUrl,
    data.data?.output_url,
    data.data?.outputUrl,
    data.data?.download_url,
    data.data?.downloadUrl,
    data.data?.remixed_from_video_id,

    data.result?.url,
    data.result?.video_url,
    data.result?.videoUrl,
    data.result?.output_url,
    data.result?.outputUrl,
    data.result?.download_url,
    data.result?.downloadUrl,
    data.result?.remixed_from_video_id,

    data.output?.url,
    data.output?.video_url,
    data.output?.videoUrl,

    data.video?.url,
    data.video?.video_url,
    data.video?.videoUrl,
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

async function createVideoTask(prompt) {
  if (!AGNES_API_KEY) {
    throw new Error(
      'AGNES_API_KEY is missing. Add AGNES_API_KEY to your environment variables.'
    );
  }

  if (!prompt || !String(prompt).trim()) {
    throw new Error('Prompt is required.');
  }

  const payload = {
    model: MODEL_NAME,
    prompt: String(prompt).trim(),

    width: WIDTH,
    height: HEIGHT,

    // ~12 seconds at 24 FPS
    num_frames: NUM_FRAMES,
    frame_rate: FRAME_RATE,
  };

  console.log('==========================================');
  console.log('[Agnes] Creating video');
  console.log('[Agnes] Model:', MODEL_NAME);
  console.log('[Agnes] Resolution:', `${WIDTH}x${HEIGHT}`);
  console.log('[Agnes] Frames:', NUM_FRAMES);
  console.log('[Agnes] FPS:', FRAME_RATE);
  console.log(
    '[Agnes] Duration:',
    `${(NUM_FRAMES / FRAME_RATE).toFixed(2)} seconds`
  );
  console.log('==========================================');

  try {
    const response = await axios.post(
      `${AGNES_BASE_URL}/v1/videos`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${AGNES_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );

    const data = response.data;

    console.log('[Agnes] Create response:');
    console.log(JSON.stringify(data, null, 2));

    const videoId =
      data?.video_id ||
      data?.videoId ||
      data?.data?.video_id ||
      data?.data?.videoId ||
      data?.result?.video_id ||
      data?.result?.videoId;

    const taskId =
      data?.task_id ||
      data?.taskId ||
      data?.id ||
      data?.data?.task_id ||
      data?.data?.taskId ||
      data?.result?.task_id;

    if (!videoId) {
      throw new Error(
        'Agnes did not return a video_id.'
      );
    }

    return {
      videoId,
      taskId: taskId || null,
      status:
        data?.status ||
        data?.data?.status ||
        'in_progress',
      progress:
        Number(
          data?.progress ??
          data?.data?.progress ??
          data?.result?.progress ??
          0
        ) || 0,
      videoUrl: extractVideoUrl(data),
      raw: data,
    };
  } catch (error) {
    console.error('[Agnes] Create request failed.');

    if (error.response) {
      console.error(
        '[Agnes] HTTP:',
        error.response.status
      );

      console.error(
        '[Agnes] Response:',
        JSON.stringify(
          error.response.data,
          null,
          2
        )
      );

      switch (error.response.status) {
        case 400:
          throw new Error(
            'Agnes rejected the request (400). Check prompt and video parameters.'
          );

        case 401:
          throw new Error(
            'Agnes authentication failed (401).'
          );

        case 403:
          throw new Error(
            'Agnes access denied (403).'
          );

        case 404:
          throw new Error(
            'Agnes API endpoint not found (404).'
          );

        case 429:
          throw new Error(
            'Agnes rate limit reached (429).'
          );

        case 500:
          throw new Error(
            'Agnes server error (500).'
          );

        case 503:
          throw new Error(
            'Agnes service unavailable (503).'
          );

        default:
          throw new Error(
            `Agnes API error (${error.response.status}).`
          );
      }
    }

    throw new Error(
      error.message || 'Failed to create Agnes video.'
    );
  }
}

async function getVideoStatus(videoId) {
  if (!videoId) {
    throw new Error('Agnes video_id is missing.');
  }

  if (!AGNES_API_KEY) {
    throw new Error(
      'AGNES_API_KEY is missing.'
    );
  }

  const url =
    `${AGNES_BASE_URL}/agnesapi` +
    `?video_id=${encodeURIComponent(videoId)}` +
    `&model_name=${encodeURIComponent(MODEL_NAME)}`;

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${AGNES_API_KEY}`,
      },
      timeout: 30000,
    });

    const data = response.data;

    console.log('==========================================');
    console.log('[Agnes] Status RAW response:');
    console.log(JSON.stringify(data, null, 2));
    console.log('==========================================');

    const status =
      data?.status ||
      data?.data?.status ||
      data?.result?.status ||
      'in_progress';

    const progress =
      Number(
        data?.progress ??
        data?.data?.progress ??
        data?.result?.progress ??
        0
      ) || 0;

    const videoUrl = extractVideoUrl(data);

    console.log('[Agnes] Parsed status:', status);
    console.log('[Agnes] Parsed progress:', progress);
    console.log('[Agnes] Parsed videoUrl:', videoUrl);

    return {
      status,
      progress,
      videoUrl,
      error:
        data?.error ||
        data?.data?.error ||
        data?.result?.error ||
        null,
      raw: data,
    };
  } catch (error) {
    console.error('[Agnes] Status request failed.');

    if (error.response) {
      console.error(
        '[Agnes] HTTP:',
        error.response.status
      );

      console.error(
        '[Agnes] Response:',
        JSON.stringify(
          error.response.data,
          null,
          2
        )
      );
    } else {
      console.error(
        '[Agnes] Error:',
        error.message
      );
    }

    throw error;
  }
}

module.exports = {
  createVideoTask,
  getVideoStatus,
  extractVideoUrl,
};