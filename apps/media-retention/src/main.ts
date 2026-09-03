import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { PreviewWriter } from './preview.writer';
import { RetentionDatabase } from './orphan.sweep';
import {
  RetentionOptions,
  RetentionRunner,
} from './retention.runner';

export interface CliOptions extends RetentionOptions {
  reportPath?: string;
}

const cliOptionsSchema = z.object({
  mode: z.enum(['dry-run', 'apply']),
  orphanMode: z.enum(['off', 'report', 'apply']),
  olderThanDays: z.number().int().positive(),
  organizationId: z.string().min(1).optional(),
  reportPath: z.string().min(1).optional(),
});

export function parseArgs(argv: string[]): CliOptions {
  let sawDryRun = false;
  let sawApply = false;
  let sawOrphanReport = false;
  let sawOrphanApply = false;
  let olderThanDays = 30;
  let organizationId: string | undefined;
  let reportPath: string | undefined;

  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (
    let index = argv[0] === 'media:retention' ? 1 : 0;
    index < argv.length;
    index += 1
  ) {
    const argument = argv[index];
    switch (argument) {
      case '--dry-run':
        sawDryRun = true;
        break;
      case '--apply':
        sawApply = true;
        break;
      case '--orphans':
        sawOrphanReport = true;
        break;
      case '--apply-orphans':
        sawOrphanApply = true;
        break;
      case '--older-than-days': {
        const value = takeValue(argument, index);
        olderThanDays = Number(value);
        index += 1;
        break;
      }
      case '--organization-id':
        organizationId = takeValue(argument, index);
        index += 1;
        break;
      case '--report':
        reportPath = takeValue(argument, index);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (sawDryRun && sawApply) {
    throw new Error('--dry-run and --apply cannot be combined');
  }
  if (sawOrphanReport && sawOrphanApply) {
    throw new Error('--orphans and --apply-orphans cannot be combined');
  }
  if (sawOrphanApply && !sawApply) {
    throw new Error('--apply-orphans requires --apply');
  }

  const parsed = cliOptionsSchema.safeParse({
    mode: sawApply ? 'apply' : 'dry-run',
    orphanMode: sawOrphanApply
      ? 'apply'
      : sawOrphanReport
      ? 'report'
      : 'off',
    olderThanDays,
    organizationId,
    reportPath,
  });
  if (!parsed.success) {
    throw new Error(
      `invalid arguments: ${parsed.error.issues
        .map((issue) =>
          issue.path[0] === 'olderThanDays'
            ? '--older-than-days must be a positive integer'
            : issue.message
        )
        .join('; ')}`
    );
  }
  // Zod v3 loses required-key inference when this repo disables strictNullChecks.
  const options = parsed.data as unknown as CliOptions;
  return options;
}

async function writeReport(filePath: string, report: object): Promise<void> {
  const absolutePath = resolve(filePath);
  const directory = dirname(absolutePath);
  await mkdir(directory, { recursive: true });
  const tempPath = `${absolutePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(tempPath, absolutePath);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const uploadDirectory = process.env.UPLOAD_DIRECTORY;
  const frontendUrl = process.env.FRONTEND_URL;
  if (!uploadDirectory || !frontendUrl) {
    throw new Error('UPLOAD_DIRECTORY and FRONTEND_URL are required');
  }

  const prisma = new PrismaClient();
  // The CLI uses a deliberately narrow, testable view of Prisma's generated API.
  const retentionDatabase = prisma as unknown as RetentionDatabase;
  const previewWriter = new PreviewWriter({ uploadDirectory, frontendUrl });
  const runner = new RetentionRunner({
    prisma: retentionDatabase,
    previewWriter,
    uploadDirectory,
    frontendUrl,
  });

  try {
    await prisma.$connect();
    const metrics = await runner.run(options);
    const report = {
      generatedAt: new Date().toISOString(),
      options: {
        mode: options.mode,
        orphanMode: options.orphanMode,
        olderThanDays: options.olderThanDays,
        ...(options.organizationId
          ? { organizationId: options.organizationId }
          : {}),
      },
      metrics,
      orphans: runner.orphanReport?.files ?? [],
    };
    if (options.reportPath) {
      await writeReport(options.reportPath, report);
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
