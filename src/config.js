// Reads and validates environment variables. Fails fast (process.exit(1)) on
// any invalid or missing required value, per PRD §5.

const X264_PRESETS = new Set([
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
  'placebo',
]);

function fail(message) {
  console.error(`[sanem] Configuration error: ${message}`);
  process.exit(1);
}

function readConfig(env = process.env) {
  const password = env.SANEM_PASSWORD;
  if (!password || password.length < 5) {
    fail('SANEM_PASSWORD is required and must be at least 5 characters long.');
  }

  const sessionSecret = env.SANEM_SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    fail('SANEM_SESSION_SECRET is required and must be at least 32 characters long.');
  }

  const port = env.SANEM_PORT ? Number.parseInt(env.SANEM_PORT, 10) : 3900;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail('SANEM_PORT must be a valid port number.');
  }

  const dataDir = env.SANEM_DATA_DIR || '/data';

  const tmpTtlHours = env.SANEM_TMP_TTL_HOURS
    ? Number.parseFloat(env.SANEM_TMP_TTL_HOURS)
    : 48;
  if (!Number.isFinite(tmpTtlHours) || tmpTtlHours <= 0) {
    fail('SANEM_TMP_TTL_HOURS must be a positive number.');
  }

  const maxFileGb = env.SANEM_MAX_FILE_GB ? Number.parseFloat(env.SANEM_MAX_FILE_GB) : 20;
  if (!Number.isFinite(maxFileGb) || maxFileGb <= 0) {
    fail('SANEM_MAX_FILE_GB must be a positive number.');
  }

  const transcodeCacheGb = env.SANEM_TRANSCODE_CACHE_GB
    ? Number.parseFloat(env.SANEM_TRANSCODE_CACHE_GB)
    : 20;
  if (!Number.isFinite(transcodeCacheGb) || transcodeCacheGb <= 0) {
    fail('SANEM_TRANSCODE_CACHE_GB must be a positive number.');
  }

  const ffmpegConcurrency = env.SANEM_FFMPEG_CONCURRENCY
    ? Number.parseInt(env.SANEM_FFMPEG_CONCURRENCY, 10)
    : 1;
  if (!Number.isInteger(ffmpegConcurrency) || ffmpegConcurrency < 1) {
    fail('SANEM_FFMPEG_CONCURRENCY must be an integer >= 1.');
  }

  const x264Preset = env.SANEM_X264_PRESET || 'veryfast';
  if (!X264_PRESETS.has(x264Preset)) {
    fail(`SANEM_X264_PRESET must be one of: ${[...X264_PRESETS].join(', ')}.`);
  }

  return {
    password,
    sessionSecret,
    port,
    dataDir,
    tmpTtlHours,
    maxFileGb,
    transcodeCacheGb,
    ffmpegConcurrency,
    x264Preset,
  };
}

export const config = readConfig();
export { readConfig };
