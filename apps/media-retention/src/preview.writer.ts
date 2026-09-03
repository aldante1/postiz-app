import { execFile } from 'node:child_process';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { toLocalUploadPath } from '@gitroom/nestjs-libraries/database/prisma/media/media.retention';

sharp.concurrency(1);

export interface PreviewMedia {
  id: string;
  type: string;
  thumbnail: string | null;
}

export interface PreviewResult {
  publicUrl: string;
  filePath: string;
  kind: 'webp' | 'jpg';
}

export type FfmpegRunner = (args: string[]) => Promise<void>;

export interface PreviewWriterOptions {
  uploadDirectory: string;
  frontendUrl: string;
  runFfmpeg?: FfmpegRunner;
}

function defaultFfmpegRunner(args: string[]): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile('ffmpeg', args, { shell: false }, (error) => {
    if (error) reject(error);
    else resolve();
  });
  return promise;
}

export function previewLocation(
  media: PreviewMedia,
  options: Pick<PreviewWriterOptions, 'uploadDirectory' | 'frontendUrl'>
): PreviewResult {
  if (!/^[A-Za-z0-9_-]+$/.test(media.id)) {
    throw new Error(`unsafe media id: ${media.id}`);
  }

  const kind = media.type.toLowerCase().startsWith('video') ? 'jpg' : 'webp';
  const relativePath = `.retention/${media.id}.${kind}`;
  return {
    publicUrl: new URL(`/uploads/${relativePath}`, options.frontendUrl).toString(),
    filePath: join(options.uploadDirectory, relativePath),
    kind,
  };
}

export class PreviewWriter {
  private readonly runFfmpeg: FfmpegRunner;

  constructor(private readonly options: PreviewWriterOptions) {
    this.runFfmpeg = options.runFfmpeg ?? defaultFfmpegRunner;
  }

  async write(media: PreviewMedia, sourcePath: string): Promise<PreviewResult> {
    const result = previewLocation(media, this.options);
    const previewDirectory = join(this.options.uploadDirectory, '.retention');
    await mkdir(previewDirectory, { recursive: true });
    const tempPath = join(
      previewDirectory,
      `.${media.id}.${randomUUID()}.tmp.${result.kind}`
    );

    try {
      if (result.kind === 'webp') {
        await sharp(sourcePath)
          .rotate()
          .resize(720, 720, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(tempPath);
      } else {
        const localThumbnail = media.thumbnail
          ? toLocalUploadPath(
              media.thumbnail,
              this.options.frontendUrl,
              this.options.uploadDirectory
            )
          : null;

        if (localThumbnail) {
          await sharp(localThumbnail)
            .rotate()
            .resize(720, 720, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(tempPath);
        } else {
          await this.runFfmpeg([
            '-threads',
            '1',
            '-ss',
            '0',
            '-i',
            sourcePath,
            '-frames:v',
            '1',
            '-vf',
            'scale=720:-2',
            tempPath,
          ]);
        }
      }

      const handle = await open(tempPath, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0) {
          throw new Error('preview output is empty');
        }
        await sharp(tempPath).metadata();
      } finally {
        await handle.close();
      }

      await rename(tempPath, result.filePath);
      return result;
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }
}
