import { BadRequestException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const MAX_NORMALIZATION_BYTES = 200 * 1024 * 1024;
const MAX_NORMALIZATION_SECONDS = 300;
const FFMPEG_TIMEOUT_MS = 480_000;
const FFPROBE_TIMEOUT_MS = 60_000;
const ALLOWED_PROFILES: Record<string, true> = {
  'Constrained Baseline': true,
  Baseline: true,
  Main: true,
  High: true,
};
const execFileAsync = promisify(execFile);

export interface VideoAudioInfo {
  codecName: string | null;
  channels: number | null;
  sampleRate: number | null;
}

export interface VideoInfo {
  codecName: string | null;
  profile: string | null;
  pixelFormat: string | null;
  width: number | null;
  height: number | null;
  averageFrameRate: number | null;
  realFrameRate: number | null;
  audioStreams: VideoAudioInfo[];
  formatName: string | null;
  duration: number | null;
  fastStart?: boolean;
}

interface ProbeRecord {
  [key: string]: unknown;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function frameRateValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const [numeratorText, denominatorText] = value.split('/');
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return null;
  }
  return numerator / denominator;
}

export function parseVideoProbe(ffprobeJson: unknown): VideoInfo | null {
  if (
    typeof ffprobeJson !== 'object' ||
    ffprobeJson === null ||
    Array.isArray(ffprobeJson)
  ) {
    return null;
  }
  const probe = ffprobeJson as ProbeRecord;
  if (!Array.isArray(probe.streams)) {
    return null;
  }

  const streams = probe.streams.filter(
    (stream): stream is ProbeRecord =>
      typeof stream === 'object' && stream !== null && !Array.isArray(stream)
  );
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video) {
    return null;
  }

  const format =
    typeof probe.format === 'object' &&
    probe.format !== null &&
    !Array.isArray(probe.format)
      ? (probe.format as ProbeRecord)
      : {};
  const audioStreams = streams
    .filter((stream) => stream.codec_type === 'audio')
    .map((stream) => ({
      codecName: stringValue(stream.codec_name),
      channels: numberValue(stream.channels),
      sampleRate: numberValue(stream.sample_rate),
    }));

  const formatDuration = numberValue(format.duration);
  const streamDuration = numberValue(video.duration);

  return {
    codecName: stringValue(video.codec_name),
    profile: stringValue(video.profile),
    pixelFormat: stringValue(video.pix_fmt),
    width: numberValue(video.width),
    height: numberValue(video.height),
    averageFrameRate: frameRateValue(video.avg_frame_rate),
    realFrameRate: frameRateValue(video.r_frame_rate),
    audioStreams,
    formatName: stringValue(format.format_name),
    duration: formatDuration ?? streamDuration,
    fastStart:
      typeof probe.fast_start === 'boolean'
        ? probe.fast_start
        : undefined,
  };
}

export function videoComplianceIssues(info: VideoInfo): string[] {
  const issues: string[] = [];

  if (!info.formatName?.split(',').includes('mp4')) {
    issues.push(`format_name "${info.formatName ?? 'missing'}" must include mp4`);
  }
  if (info.fastStart === false) {
    issues.push('moov atom must precede mdat (+faststart)');
  }
  if (info.codecName !== 'h264') {
    issues.push(`codec_name "${info.codecName ?? 'missing'}" must be h264`);
  }
  if (!info.profile || !ALLOWED_PROFILES[info.profile]) {
    issues.push(
      `profile "${info.profile ?? 'missing'}" is not browser-decodable`
    );
  }
  if (info.pixelFormat !== 'yuv420p') {
    issues.push(
      `pix_fmt "${info.pixelFormat ?? 'missing'}" must be yuv420p`
    );
  }

  if (!Number.isInteger(info.width) || (info.width ?? 0) <= 0) {
    issues.push(`width "${info.width ?? 'missing'}" must be a positive integer`);
  } else if (info.width! % 2 !== 0) {
    issues.push(`width ${info.width} must be even`);
  }
  if (!Number.isInteger(info.height) || (info.height ?? 0) <= 0) {
    issues.push(`height "${info.height ?? 'missing'}" must be a positive integer`);
  } else if (info.height! % 2 !== 0) {
    issues.push(`height ${info.height} must be even`);
  }

  const frameRate = info.averageFrameRate ?? info.realFrameRate;
  if (frameRate === null) {
    issues.push('frame rate is missing or invalid');
  } else if (frameRate > 60) {
    issues.push(`frame rate ${frameRate} fps exceeds 60 fps`);
  }

  if (info.audioStreams.length > 1) {
    issues.push(
      `audio stream count ${info.audioStreams.length} must be at most 1`
    );
  }
  for (const audio of info.audioStreams) {
    if (audio.codecName !== 'aac') {
      issues.push(
        `audio codec_name "${audio.codecName ?? 'missing'}" must be aac`
      );
    }
    if (audio.channels === null || audio.channels > 2 || audio.channels < 1) {
      issues.push(
        `audio channels "${audio.channels ?? 'missing'}" must be 1 or 2`
      );
    }
    if (audio.sampleRate !== 44_100 && audio.sampleRate !== 48_000) {
      issues.push(
        `audio sample_rate "${audio.sampleRate ?? 'missing'}" must be 44100 or 48000`
      );
    }
  }

  return issues;
}

export function normalizeFfmpegArgs(
  input: string,
  output: string,
  info: VideoInfo
): string[] {
  const args = [
    '-y',
    '-i',
    input,
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '18',
    '-preset',
    'medium',
  ];

  if (info.audioStreams.length > 0) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000');
  }

  args.push('-movflags', '+faststart', output);
  return args;
}

function hasFastStart(buffer: Buffer): boolean {
  let offset = 0;
  let moovOffset: number | null = null;
  let mdatOffset: number | null = null;

  while (offset + 8 <= buffer.length) {
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let atomSize = size32;

    if (size32 === 1) {
      if (offset + 16 > buffer.length) {
        return false;
      }
      const extendedSize = buffer.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        return false;
      }
      atomSize = Number(extendedSize);
    } else if (size32 === 0) {
      atomSize = buffer.length - offset;
    }

    if (atomSize < (size32 === 1 ? 16 : 8) || offset + atomSize > buffer.length) {
      return false;
    }
    if (type === 'moov' && moovOffset === null) {
      moovOffset = offset;
    } else if (type === 'mdat' && mdatOffset === null) {
      mdatOffset = offset;
    }
    if (moovOffset !== null && mdatOffset !== null) {
      return moovOffset < mdatOffset;
    }

    offset += atomSize;
  }

  return false;
}

async function runExecutable(
  command: string,
  args: string[],
  timeout: number
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function repairCommand(info: VideoInfo): string {
  const args = normalizeFfmpegArgs('IN', 'OUT', info);
  return `ffmpeg ${args
    .map((arg) =>
      arg === 'scale=trunc(iw/2)*2:trunc(ih/2)*2' ? `"${arg}"` : arg
    )
    .join(' ')}`;
}

function normalizationError(
  message: string,
  issues: string[],
  info: VideoInfo
): BadRequestException {
  return new BadRequestException(
    `${message} Compatibility issues: ${issues.join('; ')}. Fix it with: ${repairCommand(info)}`
  );
}

export async function normalizeVideoIfNeeded(
  buffer: Buffer,
  originalName: string
): Promise<Buffer> {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'postiz-video-'));
  const inputPath = join(tempDirectory, 'input.mp4');
  const outputPath = join(tempDirectory, 'output.mp4');

  try {
    await writeFile(inputPath, buffer);

    let rawProbe: unknown;
    try {
      const stdout = await runExecutable(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-print_format',
          'json',
          inputPath,
        ],
        FFPROBE_TIMEOUT_MS
      );
      rawProbe = JSON.parse(stdout);
    } catch {
      throw new BadRequestException(
        `Video metadata could not be read for "${originalName}". Fix it with: ffmpeg -y -i IN -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 18 -preset medium -c:a aac -b:a 128k -ac 2 -ar 48000 -movflags +faststart OUT`
      );
    }

    if (
      typeof rawProbe !== 'object' ||
      rawProbe === null ||
      Array.isArray(rawProbe)
    ) {
      throw new BadRequestException(
        `Video metadata could not be read for "${originalName}".`
      );
    }
    const info = parseVideoProbe({
      ...(rawProbe as ProbeRecord),
      fast_start: hasFastStart(buffer),
    });
    if (!info) {
      throw new BadRequestException(
        `No video stream was found in "${originalName}".`
      );
    }

    const issues = videoComplianceIssues(info);
    if (issues.length === 0) {
      return buffer;
    }

    if (buffer.length > MAX_NORMALIZATION_BYTES) {
      throw normalizationError(
        `Video "${originalName}" cannot be normalized because its size ${buffer.length} bytes exceeds 209715200 bytes.`,
        issues,
        info
      );
    }
    if (info.duration === null) {
      throw normalizationError(
        `Video "${originalName}" cannot be normalized because its duration could not be determined.`,
        issues,
        info
      );
    }
    if (info.duration > MAX_NORMALIZATION_SECONDS) {
      throw normalizationError(
        `Video "${originalName}" cannot be normalized because its duration ${info.duration} seconds exceeds 300 seconds.`,
        issues,
        info
      );
    }

    const canonicalArgs = normalizeFfmpegArgs(inputPath, outputPath, info);
    const ffmpegArgs = [
      ...canonicalArgs.slice(0, -1),
      '-threads',
      '2',
      canonicalArgs[canonicalArgs.length - 1],
    ];
    try {
      await runExecutable('ffmpeg', ffmpegArgs, FFMPEG_TIMEOUT_MS);
    } catch (error) {
      const processError = error as NodeJS.ErrnoException & {
        killed?: boolean;
        signal?: string;
      };
      const timedOut =
        processError.killed === true || processError.signal === 'SIGKILL';
      throw normalizationError(
        timedOut
          ? `Video "${originalName}" normalization timed out after 480 seconds.`
          : `Video "${originalName}" normalization failed.`,
        issues,
        info
      );
    }

    return await readFile(outputPath);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
