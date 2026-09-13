import { toLocalUploadPath } from '@gitroom/nestjs-libraries/database/prisma/media/media.retention';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const FFPROBE_TIMEOUT_MS = 60_000;
const execFileAsync = promisify(execFile);

type ProbeRecord = Record<string, unknown>;

export type TelegramVideoGeometry = {
  width: number;
  height: number;
  duration: number;
  supports_streaming: true;
};

function positiveNumber(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sampleAspectRatio(value: unknown): number | null {
  if (value === undefined || value === null || value === 'N/A') {
    return 1;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) {
    return null;
  }

  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  return numerator > 0 && denominator > 0 ? numerator / denominator : null;
}

function parseGeometry(probe: unknown): TelegramVideoGeometry | null {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
    return null;
  }

  const record = probe as ProbeRecord;
  if (!Array.isArray(record.streams)) {
    return null;
  }

  const video = record.streams.find(
    (stream): stream is ProbeRecord =>
      !!stream &&
      typeof stream === 'object' &&
      !Array.isArray(stream) &&
      (stream as ProbeRecord).codec_type === 'video'
  );
  if (!video) {
    return null;
  }

  const format =
    record.format &&
    typeof record.format === 'object' &&
    !Array.isArray(record.format)
      ? (record.format as ProbeRecord)
      : {};
  const encodedWidth = positiveNumber(video.width);
  const height = positiveNumber(video.height);
  const duration =
    positiveNumber(video.duration) ?? positiveNumber(format.duration);
  const sar = sampleAspectRatio(video.sample_aspect_ratio);
  if (
    encodedWidth === null ||
    height === null ||
    duration === null ||
    sar === null
  ) {
    return null;
  }

  const width = Math.round(encodedWidth * sar);
  const roundedHeight = Math.round(height);
  const roundedDuration = Math.ceil(duration);
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(roundedHeight) ||
    roundedHeight <= 0 ||
    !Number.isSafeInteger(roundedDuration) ||
    roundedDuration <= 0
  ) {
    return null;
  }

  return {
    width,
    height: roundedHeight,
    duration: roundedDuration,
    supports_streaming: true,
  };
}

async function runFfprobe(filePath: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_type,width,height,duration,sample_aspect_ratio:format=duration',
      '-print_format',
      'json',
      filePath,
    ],
    {
      timeout: FFPROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    }
  );

  return JSON.parse(stdout);
}

export async function getTelegramVideoGeometry(
  publicUrl: string
): Promise<TelegramVideoGeometry | null> {
  if (process.env.STORAGE_PROVIDER !== 'local') {
    return null;
  }

  const frontendUrl = process.env.FRONTEND_URL;
  const uploadDirectory = process.env.UPLOAD_DIRECTORY;
  if (!frontendUrl || !uploadDirectory) {
    return null;
  }

  const filePath = toLocalUploadPath(publicUrl, frontendUrl, uploadDirectory);
  if (!filePath) {
    return null;
  }

  try {
    return parseGeometry(await runFfprobe(filePath));
  } catch {
    return null;
  }
}
