import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseArgs } from './main';
import { OrphanSweep } from './orphan.sweep';
import { PreviewWriter } from './preview.writer';
import { RetentionRunner } from './retention.runner';

const FRONTEND_URL = 'https://postiz.example';
const NOW = new Date('2026-09-03T12:00:00.000Z');

type Row = Record<string, unknown>;

class FixtureDatabase {
  mediaRows: Row[] = [];
  postRows: Row[] = [];
  setRows: Row[] = [];
  integrationRows: Row[] = [];
  userRows: Row[] = [];
  agencyRows: Row[] = [];
  oauthRows: Row[] = [];
  updates: Array<{ model: string; id: string; data: Row }> = [];
  events: string[] = [];
  holderReads = 0;
  holderMutationRead = 2;
  afterFirstHolderRead?: () => void;

  private selected(rows: Row[], args: Row = {}) {
    const where = args.where ?? {};
    const filtered = rows.filter((row) => {
      if (where.id && row.id !== where.id) return false;
      if (where.organizationId && row.organizationId !== where.organizationId) return false;
      if (where.deletedAt === null && row.deletedAt != null) return false;
      if (where.retentionState?.in && !where.retentionState.in.includes(row.retentionState)) return false;
      if (where.createdAt?.lte && row.createdAt > where.createdAt.lte) return false;
      if (where.OR) {
        const matches = where.OR.some((clause: Row) => {
          if (clause.createdAt?.gt) return row.createdAt > clause.createdAt.gt;
          if (clause.createdAt?.equals && row.createdAt.getTime() !== clause.createdAt.equals.getTime()) return false;
          if (clause.id?.gt) return row.id > clause.id.gt;
          return true;
        });
        if (!matches) return false;
      }
      return true;
    });
    return filtered.map((row) => {
      if (!args.select) return { ...row };
      return Object.fromEntries(
        Object.keys(args.select).filter((key) => args.select[key]).map((key) => [key, row[key]])
      );
    });
  }

  private update(rows: Row[], model: string, args: Row) {
    const row = rows.find((item) => item.id === args.where.id);
    if (!row) throw new Error(`${model} row not found`);
    Object.assign(row, args.data);
    this.updates.push({ model, id: row.id, data: { ...args.data } });
    return { ...row };
  }

  media = {
    findFirst: async (_args: Row): Promise<unknown> => undefined,
    findMany: async (_args: Row): Promise<unknown> => undefined,
    update: async (_args: Row): Promise<unknown> => undefined,
  };
  post = {
    findMany: async (_args: Row): Promise<unknown> => undefined,
    update: async (_args: Row): Promise<unknown> => undefined,
  };
  sets = { findMany: async (_args: Row): Promise<unknown> => undefined };
  integration = { findMany: async (_args: Row): Promise<unknown> => undefined };
  user = { findMany: async (_args: Row): Promise<unknown> => undefined };
  socialMediaAgency = { findMany: async (_args: Row): Promise<unknown> => undefined };
  oAuthApp = { findMany: async (_args: Row): Promise<unknown> => undefined };
  $queryRaw = async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    this.events.push('for-update');
    return [{ id: 'm1' }];
  };
  $transaction = async (
    callback: (database: FixtureDatabase) => Promise<unknown>
  ) => callback(this);

  constructor() {
    this.media.findFirst = async (args: Row) => this.selected(this.mediaRows, args)[0] ?? null;
    this.media.findMany = async (args: Row) => this.selected(this.mediaRows, args);
    this.media.update = async (args: Row) => {
      this.events.push('media-update');
      return this.update(this.mediaRows, 'media', args);
    };
    this.post.findMany = async (args: Row) => {
      this.noteHolderRead();
      this.events.push('holder-read');
      return this.selected(this.postRows, args);
    };
    this.post.update = async (args: Row) => this.update(this.postRows, 'post', args);
    this.sets.findMany = async (args: Row) => this.selected(this.setRows, args);
    this.integration.findMany = async (args: Row) => this.selected(this.integrationRows, args);
    this.user.findMany = async (args: Row) => this.selected(this.userRows, args);
    this.socialMediaAgency.findMany = async (args: Row) => this.selected(this.agencyRows, args);
    this.oAuthApp.findMany = async (args: Row) => this.selected(this.oauthRows, args);
  }

  private noteHolderRead() {
    this.holderReads += 1;
    if (this.holderReads === this.holderMutationRead) {
      this.afterFirstHolderRead?.();
    }
  }
}

function media(overrides: Row = {}): Row {
  return {
    id: 'm1',
    name: 'm1.png',
    path: `${FRONTEND_URL}/uploads/m1.png`,
    thumbnail: null,
    archivePreviewPath: null,
    fileSize: 6,
    type: 'image',
    organizationId: 'org-1',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    deletedAt: null,
    retentionState: 'ACTIVE',
    originalPurgedAt: null,
    ...overrides,
  };
}

function publishedPost(overrides: Row = {}): Row {
  return {
    id: 'post-1',
    state: 'PUBLISHED',
    deletedAt: null,
    image: JSON.stringify([{ id: 'm1', path: `${FRONTEND_URL}/uploads/m1.png` }]),
    settings: '{}',
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('defaults to a non-mutating retention run with orphan sweeping disabled', () => {
    expect(parseArgs([])).toEqual({
      mode: 'dry-run',
      orphanMode: 'off',
      olderThanDays: 30,
    });
  });

  it('parses apply, organization, age, orphan, and report flags', () => {
    expect(
      parseArgs([
        '--apply',
        '--apply-orphans',
        '--older-than-days',
        '45',
        '--organization-id',
        'org-1',
        '--report',
        '/tmp/report.json',
      ])
    ).toEqual({
      mode: 'apply',
      orphanMode: 'apply',
      olderThanDays: 45,
      organizationId: 'org-1',
      reportPath: '/tmp/report.json',
    });
  });

  it('rejects ambiguous or unsafe mutation flags', () => {
    expect(() => parseArgs(['--dry-run', '--apply'])).toThrow('cannot be combined');
    expect(() => parseArgs(['--apply-orphans'])).toThrow('requires --apply');
    expect(() => parseArgs(['--orphans', '--apply-orphans'])).toThrow('cannot be combined');
    expect(() => parseArgs(['--older-than-days', '0'])).toThrow('positive integer');
    expect(() => parseArgs(['--unknown'])).toThrow('unknown argument');
  });
});

describe('PreviewWriter', () => {
  let root: string;
  let uploads: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'postiz-preview-writer-'));
    uploads = join(root, 'uploads');
    mkdirSync(uploads);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes an image preview atomically as a bounded WebP', async () => {
    const source = join(uploads, 'source.svg');
    writeFileSync(source, '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="450"><rect width="900" height="450" fill="red"/></svg>');
    const writer = new PreviewWriter({ uploadDirectory: uploads, frontendUrl: FRONTEND_URL });

    const result = await writer.write(media(), source);
    const metadata = await sharp(result.filePath).metadata();

    expect(result).toEqual({
      publicUrl: `${FRONTEND_URL}/uploads/.retention/m1.webp`,
      filePath: join(realpathSync(uploads), '.retention', 'm1.webp'),
      kind: 'webp',
    });
    expect(metadata.width).toBe(720);
    expect(metadata.height).toBe(360);
    expect(readdirSync(join(uploads, '.retention'))).toEqual(['m1.webp']);
  });

  it('uses a trusted local video thumbnail and does not invoke ffmpeg', async () => {
    const source = join(uploads, 'video.mp4');
    const thumbnail = join(uploads, 'thumb.png');
    writeFileSync(source, 'not-needed');
    await sharp({ create: { width: 20, height: 10, channels: 3, background: 'blue' } }).png().toFile(thumbnail);
    const runFfmpeg = jest.fn(async () => { throw new Error('ffmpeg must not run'); });
    const writer = new PreviewWriter({ uploadDirectory: uploads, frontendUrl: FRONTEND_URL, runFfmpeg });

    const result = await writer.write(
      media({ type: 'video', thumbnail: `${FRONTEND_URL}/uploads/thumb.png` }),
      source
    );

    expect(result.kind).toBe('jpg');
    expect((await sharp(result.filePath).metadata()).format).toBe('jpeg');
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it('extracts one video frame with one ffmpeg thread when no safe thumbnail exists', async () => {
    const source = join(uploads, 'video.mp4');
    writeFileSync(source, 'video');
    const calls: string[][] = [];
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'green' } }).jpeg().toBuffer();
    const writer = new PreviewWriter({
      uploadDirectory: uploads,
      frontendUrl: FRONTEND_URL,
      runFfmpeg: async (args) => {
        calls.push(args);
        writeFileSync(args.at(-1)!, jpeg);
      },
    });

    const result = await writer.write(media({ type: 'video', thumbnail: 'https://cdn.example/thumb.jpg' }), source);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      '-threads', '1', '-ss', '0', '-i', realpathSync(source), '-frames:v', '1', '-vf', 'scale=720:-2',
      expect.stringMatching(/\.jpg$/),
    ]);
    expect((await sharp(result.filePath).metadata()).format).toBe('jpeg');
  });
  it('treats a stored .mp4 as video when current-schema Media.type is image', async () => {
    const source = join(uploads, 'current-schema.mp4');
    writeFileSync(source, 'video');
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: 'green' },
    }).jpeg().toBuffer();
    const runFfmpeg = jest.fn(async (args: string[]) => {
      writeFileSync(args.at(-1)!, jpeg);
    });
    const writer = new PreviewWriter({
      uploadDirectory: uploads,
      frontendUrl: FRONTEND_URL,
      runFfmpeg,
    });

    const result = await writer.write(media({ type: 'image' }), source);

    expect(result.kind).toBe('jpg');
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
  });

  it('rejects a symlinked reserved preview directory without writing outside uploads', async () => {
    const source = join(uploads, 'source.svg');
    const outside = join(root, 'outside');
    writeFileSync(source, '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\"/>');
    mkdirSync(outside);
    symlinkSync(outside, join(uploads, '.retention'));
    const writer = new PreviewWriter({
      uploadDirectory: uploads,
      frontendUrl: FRONTEND_URL,
    });

    await expect(writer.write(media(), source)).rejects.toThrow(
      'unsafe retention directory'
    );
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('RetentionRunner', () => {
  let root: string;
  let uploads: string;
  let db: FixtureDatabase;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'postiz-retention-runner-'));
    uploads = join(root, 'uploads');
    mkdirSync(join(uploads, '.retention'), { recursive: true });
    db = new FixtureDatabase();
    db.holderMutationRead = 3;
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const makeRunner = (previewWriter: Row = {}) => {
    const location = async (row: Row) => {
      const filePath = join(uploads, '.retention', `${row.id}.webp`);
      return {
        filePath,
        publicUrl: `${FRONTEND_URL}/uploads/.retention/${row.id}.webp`,
        kind: 'webp',
      };
    };
    const defaultWriter = {
      location,
      prepare: async (row: Row) => {
        const result = await location(row);
        const tempPath = join(uploads, '.retention', `.${row.id}.prepared.webp`);
        writeFileSync(tempPath, 'preview');
        const stat = statSync(tempPath);
        return {
          tempPath,
          result,
          identity: {
            path: realpathSync(tempPath),
            size: stat.size,
            device: stat.dev,
            inode: stat.ino,
            mtimeMs: stat.mtimeMs,
          },
        };
      },
      publish: async (prepared: Row) => {
        writeFileSync(prepared.result.filePath, readFileSync(prepared.tempPath));
        rmSync(prepared.tempPath);
        return prepared.result;
      },
      discard: async (prepared: Row) =>
        rmSync(prepared.tempPath, { force: true }),
    };
    // The fixture implements the narrow runtime delegates but keeps generic test rows.
    const prisma = db as unknown as ConstructorParameters<typeof RetentionRunner>[0]['prisma'];
    const writer = {
      ...defaultWriter,
      ...previewWriter,
    } as unknown as ConstructorParameters<typeof RetentionRunner>[0]['previewWriter'];
    return new RetentionRunner({
      prisma,
      previewWriter: writer,
      uploadDirectory: uploads,
      frontendUrl: FRONTEND_URL,
      now: () => NOW,
    });
  };

  it('dry-run discovers a candidate without changing the database or filesystem', async () => {
    db.mediaRows = [media()];
    db.postRows = [publishedPost()];
    const source = join(uploads, 'm1.png');
    writeFileSync(source, 'source');
    const before = readFileSync(source, 'utf8');

    const result = await makeRunner().run({ mode: 'dry-run', orphanMode: 'off', olderThanDays: 30 });

    expect(result).toEqual({ candidates: 1, skipped: 0, staged: 0, purged: 0, bytesFreed: 0, errors: [] });
    expect(readFileSync(source, 'utf8')).toBe(before);
    expect(readdirSync(join(uploads, '.retention'))).toEqual([]);
    expect(db.updates).toEqual([]);
  });
  it('rejects orphan deletion when the retention run is dry-run', async () => {
    const orphan = join(uploads, 'orphan.bin');
    writeFileSync(orphan, 'orphan');
    utimesSync(orphan, new Date('2026-07-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'));

    await expect(makeRunner().run({
      mode: 'dry-run',
      orphanMode: 'apply',
      olderThanDays: 30,
    })).rejects.toThrow('orphan apply requires retention apply');

    expect(existsSync(orphan)).toBe(true);
    expect(db.updates).toEqual([]);
  });


  it('takes the Media write lock before eligibility reads and mutation', async () => {
    db.mediaRows = [media()];
    db.postRows = [publishedPost()];
    writeFileSync(join(uploads, 'm1.png'), 'source');

    await makeRunner().run({ mode: 'apply', orphanMode: 'off', olderThanDays: 30 });

    const lockIndex = db.events.indexOf('for-update');
    expect(db.events.indexOf('holder-read')).toBeLessThan(lockIndex);
    expect(lockIndex).toBeLessThan(
      db.events.indexOf('holder-read', lockIndex + 1)
    );
    expect(lockIndex).toBeLessThan(db.events.indexOf('media-update'));
  });
  it('generates the preview before locking but publishes it only after revalidation', async () => {
    db.mediaRows = [media()];
    db.postRows = [publishedPost()];
    const source = join(uploads, 'm1.png');
    const finalPath = join(uploads, '.retention', 'm1.webp');
    const tempPath = join(uploads, '.retention', '.prepared.webp');
    writeFileSync(source, 'source');
    const writer = {
      location: async () => ({
        publicUrl: `${FRONTEND_URL}/uploads/.retention/m1.webp`,
        filePath: finalPath,
        kind: 'webp',
      }),
      prepare: async () => {
        db.events.push('preview-prepare');
        writeFileSync(tempPath, 'preview');
        return {
          tempPath,
          result: {
            publicUrl: `${FRONTEND_URL}/uploads/.retention/m1.webp`,
            filePath: finalPath,
            kind: 'webp',
          },
        };
      },
      publish: async (prepared: Row) => {
        db.events.push('preview-publish');
        writeFileSync(finalPath, readFileSync(tempPath));
        rmSync(tempPath);
        return prepared.result;
      },
      discard: async () => rmSync(tempPath, { force: true }),
      write: async () => {
        throw new Error('runner must use two-phase preview generation');
      },
    };

    await makeRunner(writer).run({
      mode: 'apply',
      orphanMode: 'off',
      olderThanDays: 30,
    });

    expect(db.events.indexOf('preview-prepare')).toBeLessThan(
      db.events.indexOf('for-update')
    );
    expect(db.events.indexOf('for-update')).toBeLessThan(
      db.events.indexOf('preview-publish')
    );
  });


  it('runs ACTIVE through preview, published JSON rewrite, STAGED, unlink, and PURGED', async () => {
    db.mediaRows = [media()];
    db.postRows = [publishedPost({ settings: JSON.stringify({ nested: { id: 'm1', url: 'old' } }) })];
    const source = join(uploads, 'm1.png');
    writeFileSync(source, 'source');

    const result = await makeRunner().run({ mode: 'apply', orphanMode: 'off', olderThanDays: 30 });

    expect(result).toEqual({ candidates: 1, skipped: 0, staged: 1, purged: 1, bytesFreed: 6, errors: [] });
    expect(existsSync(source)).toBe(false);
    expect(db.mediaRows[0]).toEqual(expect.objectContaining({
      retentionState: 'PURGED',
      archivePreviewPath: `${FRONTEND_URL}/uploads/.retention/m1.webp`,
      originalPurgedAt: NOW,
    }));
    expect(db.postRows[0].image).toContain('/uploads/.retention/m1.webp');
    expect(db.postRows[0].settings).toContain('/uploads/.retention/m1.webp');
  });
  it('recovers ACTIVE after preview creation without generating it twice', async () => {
    db.mediaRows = [media()];
    db.postRows = [publishedPost()];
    writeFileSync(join(uploads, 'm1.png'), 'source');
    writeFileSync(join(uploads, '.retention', 'm1.webp'), 'preview');
    const previewWriter = { prepare: jest.fn(async () => {
      throw new Error('preview must not be regenerated');
    }) };

    const result = await makeRunner(previewWriter).run({
      mode: 'apply',
      orphanMode: 'off',
      olderThanDays: 30,
    });

    expect(result.staged).toBe(1);
    expect(result.purged).toBe(1);
    expect(previewWriter.prepare).not.toHaveBeenCalled();
  });


  it.each([
    ['purges a staged original when its preview exists', true, true, 1],
    ['finalizes a staged row when unlink already happened', true, false, 1],
    ['regenerates a missing staged preview from its original', false, true, 1],
  ])('%s', async (_name, previewExists, originalExists, expectedPurged) => {
    const previewUrl = `${FRONTEND_URL}/uploads/.retention/m1.webp`;
    db.mediaRows = [media({ retentionState: 'STAGED', archivePreviewPath: previewUrl })];
    db.postRows = [publishedPost({ image: JSON.stringify([{ id: 'm1', path: previewUrl }]) })];
    if (originalExists) writeFileSync(join(uploads, 'm1.png'), 'source');
    if (previewExists) writeFileSync(join(uploads, '.retention', 'm1.webp'), 'preview');

    const result = await makeRunner().run({ mode: 'apply', orphanMode: 'off', olderThanDays: 30 });

    expect(result.purged).toBe(expectedPurged);
    expect(db.mediaRows[0].retentionState).toBe('PURGED');
    expect(db.mediaRows[0].originalPurgedAt).toEqual(NOW);
  });
  it('repairs missing archive metadata while recovering a staged row', async () => {
    const previewUrl = `${FRONTEND_URL}/uploads/.retention/m1.webp`;
    db.mediaRows = [media({ retentionState: 'STAGED', archivePreviewPath: null })];
    db.postRows = [publishedPost({ image: JSON.stringify([{ id: 'm1', path: previewUrl }]) })];
    writeFileSync(join(uploads, 'm1.png'), 'source');
    writeFileSync(join(uploads, '.retention', 'm1.webp'), 'preview');

    await makeRunner().run({ mode: 'apply', orphanMode: 'off', olderThanDays: 30 });

    expect(db.mediaRows[0].archivePreviewPath).toBe(previewUrl);
    expect(db.mediaRows[0].retentionState).toBe('PURGED');
  });


  it('finalizes ACTIVE recovery when preview exists and original is already gone', async () => {
    const previewUrl = `${FRONTEND_URL}/uploads/.retention/m1.webp`;
    db.mediaRows = [media({ archivePreviewPath: previewUrl })];
    db.postRows = [publishedPost()];
    writeFileSync(join(uploads, '.retention', 'm1.webp'), 'preview');

    const result = await makeRunner().run({ mode: 'apply', orphanMode: 'off', olderThanDays: 30 });

    expect(result.staged).toBe(1);
    expect(result.purged).toBe(1);
    expect(db.postRows[0].image).toContain('/uploads/.retention/m1.webp');
  });

  it.each(['ACTIVE', 'STAGED'] as const)(
    'fails %s apply when both preview and original are missing',
    async (retentionState) => {
      db.mediaRows = [media({ retentionState })];
      await expect(makeRunner().run({
        mode: 'apply',
        orphanMode: 'off',
        olderThanDays: 30,
      })).rejects.toThrow('preview missing and original missing');
    }
  );

  it('skips an external URL without touching it', async () => {
    db.mediaRows = [media({ path: 'https://cdn.example/m1.png' })];
    const result = await makeRunner().run({ mode: 'apply', orphanMode: 'off', olderThanDays: 30 });
    expect(result).toEqual({ candidates: 1, skipped: 1, staged: 0, purged: 0, bytesFreed: 0, errors: [] });
    expect(db.updates).toEqual([]);
  });

  it.each([
    ['draft Post.image', (candidate: Row) => { db.postRows = [publishedPost({ state: 'DRAFT', image: JSON.stringify([{ id: candidate.id }]) })]; }],
    ['queued Post.settings', (candidate: Row) => { db.postRows = [publishedPost({ state: 'QUEUE', image: '[]', settings: JSON.stringify({ id: candidate.id }) })]; }],
    ['Sets.content', (candidate: Row) => { db.setRows = [{ id: 'set-1', content: JSON.stringify({ id: candidate.id }) }]; }],
    ['Integration.picture', (candidate: Row) => { db.integrationRows = [{ id: 'integration-1', picture: candidate.path, deletedAt: null }]; }],
    ['User.pictureId', (candidate: Row) => { db.userRows = [{ id: 'user-1', pictureId: candidate.id }]; }],
    ['SocialMediaAgency.logoId', (candidate: Row) => { db.agencyRows = [{ id: 'agency-1', logoId: candidate.id, deletedAt: null }]; }],
    ['OAuthApp.pictureId', (candidate: Row) => { db.oauthRows = [{ id: 'oauth-1', pictureId: candidate.id, deletedAt: null }]; }],
    ['another Media.path', (candidate: Row) => { db.mediaRows.push(media({ id: 'm2', path: candidate.path, createdAt: NOW })); }],
    ['another Media.thumbnail', (candidate: Row) => { db.mediaRows.push(media({ id: 'm2', path: `${FRONTEND_URL}/uploads/m2.png`, thumbnail: candidate.path, createdAt: NOW })); }],
  ])('protects a live %s holder', async (_name, addHolder) => {
    const candidate = media();
    db.mediaRows = [candidate];
    writeFileSync(join(uploads, 'm1.png'), 'source');
    addHolder(candidate);

    const result = await makeRunner().run({ mode: 'apply', orphanMode: 'off', olderThanDays: 30 });

    expect(result.skipped).toBe(1);
    expect(existsSync(join(uploads, 'm1.png'))).toBe(true);
    expect(db.updates).toEqual([]);
  });

  it('does not stage when a published field would retain an original-path occurrence', async () => {
    db.mediaRows = [media()];
    db.postRows = [publishedPost({
      image: JSON.stringify([{
        id: 'm1',
        path: `${FRONTEND_URL}/uploads/m1.png`,
        source: `${FRONTEND_URL}/uploads/m1.png`,
      }]),
    })];
    writeFileSync(join(uploads, 'm1.png'), 'source');

    const result = await makeRunner().run({
      mode: 'apply',
      orphanMode: 'off',
      olderThanDays: 30,
    });

    expect(result.staged).toBe(0);
    expect(result.errors).toEqual([
      expect.stringContaining('unrewritten original path'),
    ]);
    expect(db.mediaRows[0].retentionState).toBe('ACTIVE');
    expect(db.updates).toEqual([]);
  });

  it('repairs a partially rewritten STAGED published entry before purge', async () => {
    const previewUrl = `${FRONTEND_URL}/uploads/.retention/m1.webp`;
    db.mediaRows = [media({
      retentionState: 'STAGED',
      archivePreviewPath: previewUrl,
    })];
    db.postRows = [publishedPost()];
    writeFileSync(join(uploads, 'm1.png'), 'source');
    writeFileSync(join(uploads, '.retention', 'm1.webp'), 'preview');

    const result = await makeRunner().run({
      mode: 'apply',
      orphanMode: 'off',
      olderThanDays: 30,
    });

    expect(result.purged).toBe(1);
    expect(db.postRows[0].image).toContain(previewUrl);
    expect(db.postRows[0].image).not.toContain('/uploads/m1.png');
  });

  it('ignores soft-deleted Post, Integration, agency, OAuth app, and Media holders', async () => {
    const candidate = media({ deletedAt: new Date('2026-08-01T00:00:00Z') });
    db.mediaRows = [candidate, media({ id: 'm2', path: `${FRONTEND_URL}/uploads/m2.png`, thumbnail: candidate.path, deletedAt: NOW, createdAt: NOW })];
    db.postRows = [publishedPost({ state: 'DRAFT', deletedAt: NOW })];
    db.integrationRows = [{ id: 'i1', picture: candidate.path, deletedAt: NOW }];
    db.agencyRows = [{ id: 'a1', logoId: candidate.id, deletedAt: NOW }];
    db.oauthRows = [{ id: 'o1', pictureId: candidate.id, deletedAt: NOW }];
    writeFileSync(join(uploads, 'm1.png'), 'source');

    const result = await makeRunner().run({ mode: 'apply', orphanMode: 'off', olderThanDays: 30 });

    expect(result.purged).toBe(1);
  });

  it('conservatively blocks on any malformed holder JSON', async () => {
    db.mediaRows = [media()];
    db.postRows = [publishedPost({ image: '{"id":"unrelated"' })];
    writeFileSync(join(uploads, 'm1.png'), 'source');

    const result = await makeRunner().run({ mode: 'apply', orphanMode: 'off', olderThanDays: 30 });

    expect(result.errors).toEqual([expect.stringContaining('Post.image')]);
    expect(db.updates).toEqual([]);
    expect(existsSync(join(uploads, 'm1.png'))).toBe(true);
  });

  it('revalidates holders after staging and leaves a newly referenced original intact', async () => {
    db.mediaRows = [media()];
    db.postRows = [publishedPost()];
    db.afterFirstHolderRead = () => {
      db.setRows.push({ id: 'late-set', content: JSON.stringify({ id: 'm1' }) });
    };
    writeFileSync(join(uploads, 'm1.png'), 'source');

    const result = await makeRunner().run({ mode: 'apply', orphanMode: 'off', olderThanDays: 30 });

    expect(result.staged).toBe(1);
    expect(result.purged).toBe(0);
    expect(result.skipped).toBe(1);
    expect(existsSync(join(uploads, 'm1.png'))).toBe(true);
    expect(db.mediaRows[0].retentionState).toBe('STAGED');
  });
  it('does not unlink an original replaced while the row is being staged', async () => {
    db.mediaRows = [media()];
    db.postRows = [publishedPost()];
    const source = join(uploads, 'm1.png');
    writeFileSync(source, 'source');
    db.afterFirstHolderRead = () => {
      rmSync(source);
      writeFileSync(source, 'replacement');
    };

    const result = await makeRunner().run({
      mode: 'apply',
      orphanMode: 'off',
      olderThanDays: 30,
    });

    expect(result.purged).toBe(0);
    expect(result.errors).toEqual([expect.stringContaining('changed before unlink')]);
    expect(readFileSync(source, 'utf8')).toBe('replacement');
    expect(db.mediaRows[0].retentionState).toBe('STAGED');
  });

});

describe('OrphanSweep', () => {
  let root: string;
  let uploads: string;
  let db: FixtureDatabase;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'postiz-orphan-sweep-'));
    uploads = join(root, 'uploads');
    mkdirSync(join(uploads, '.retention'), { recursive: true });
    db = new FixtureDatabase();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function oldFile(relativePath: string, contents = 'orphan') {
    const filePath = join(uploads, relativePath);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, contents);
    const old = new Date('2026-07-01T00:00:00Z');
    utimesSync(filePath, old, old);
    return filePath;
  }

  const makeSweep = () => {
    // The fixture implements the narrow runtime delegates but keeps generic test rows.
    const prisma = db as unknown as ConstructorParameters<typeof OrphanSweep>[0]['prisma'];
    return new OrphanSweep({
      prisma,
      uploadDirectory: uploads,
      frontendUrl: FRONTEND_URL,
      now: () => NOW,
    });
  };

  it('reports only old unheld files and protects the reserved preview directory', async () => {
    const orphan = oldFile('old.bin', '123456');
    const integration = oldFile('integration.png');
    oldFile('.retention/preview.webp');
    oldFile('media.png');
    db.mediaRows = [media({ path: `${FRONTEND_URL}/uploads/media.png` })];
    db.integrationRows = [{ id: 'integration-1', picture: `${FRONTEND_URL}/uploads/integration.png`, deletedAt: null }];

    const result = await makeSweep().run({ mode: 'report', olderThanDays: 30 });

    expect(result.files).toEqual([{ path: realpathSync(orphan), bytes: 6, deleted: false }]);
    expect(result.bytesFreed).toBe(0);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(integration)).toBe(true);
  });
  it.each([
    ['Post.image', (target: Row) => {
      db.mediaRows = [media({ ...target, retentionState: 'PURGED' })];
      db.postRows = [publishedPost({ image: JSON.stringify([{ id: target.id }]) })];
    }],
    ['Post.settings', (target: Row) => {
      db.mediaRows = [media({ ...target, retentionState: 'PURGED' })];
      db.postRows = [publishedPost({ image: '[]', settings: JSON.stringify({ media: { id: target.id } }) })];
    }],
    ['Sets.content', (target: Row) => {
      db.mediaRows = [media({ ...target, retentionState: 'PURGED' })];
      db.setRows = [{ id: 'set-1', content: JSON.stringify({ id: target.id }) }];
    }],
    ['Integration.picture', (target: Row) => {
      db.integrationRows = [{ id: 'integration-1', picture: target.path, deletedAt: null }];
    }],
    ['Media.path', (target: Row) => {
      db.mediaRows = [media(target)];
    }],
    ['Media.thumbnail', (target: Row) => {
      db.mediaRows = [media({ id: 'holder', path: `${FRONTEND_URL}/uploads/holder.png`, thumbnail: target.path, createdAt: NOW })];
    }],
    ['Media.archivePreviewPath', (target: Row) => {
      db.mediaRows = [media({ id: 'holder', path: `${FRONTEND_URL}/uploads/holder.png`, archivePreviewPath: target.path, createdAt: NOW })];
    }],
    ['User.pictureId', (target: Row) => {
      db.mediaRows = [media({ ...target, retentionState: 'PURGED' })];
      db.userRows = [{ id: 'user-1', pictureId: target.id }];
    }],
    ['SocialMediaAgency.logoId', (target: Row) => {
      db.mediaRows = [media({ ...target, retentionState: 'PURGED' })];
      db.agencyRows = [{ id: 'agency-1', logoId: target.id, deletedAt: null }];
    }],
    ['OAuthApp.pictureId', (target: Row) => {
      db.mediaRows = [media({ ...target, retentionState: 'PURGED' })];
      db.oauthRows = [{ id: 'oauth-1', pictureId: target.id, deletedAt: null }];
    }],
  ])('keeps an orphan candidate referenced by %s', async (_holder, addHolder) => {

    const target = media({ path: `${FRONTEND_URL}/uploads/held.png` });
    const held = oldFile('held.png');
    addHolder(target);

    const result = await makeSweep().run({ mode: 'report', olderThanDays: 30 });

    expect(result.files).toEqual([]);
    expect(existsSync(held)).toBe(true);
  });
  it('keeps every orphan when any holder JSON is malformed', async () => {
    const candidate = oldFile('malformed-held.png');
    db.mediaRows = [media({
      path: `${FRONTEND_URL}/uploads/malformed-held.png`,
      retentionState: 'PURGED',
    })];
    db.setRows = [{ id: 'broken-set', content: '{"id":"unrelated"' }];

    const result = await makeSweep().run({ mode: 'apply', olderThanDays: 30 });

    expect(existsSync(candidate)).toBe(true);
    expect(result.files).toEqual([
      { path: realpathSync(candidate), bytes: 6, deleted: false },
    ]);
    expect(result.errors).toEqual([expect.stringContaining('Sets.content')]);
  });


  it('does not mutate files or the database in report mode', async () => {
    const orphan = oldFile('orphan.bin');
    const before = statSync(orphan).mtimeMs;

    await makeSweep().run({ mode: 'report', olderThanDays: 30 });

    expect(existsSync(orphan)).toBe(true);
    expect(statSync(orphan).mtimeMs).toBe(before);
    expect(db.updates).toEqual([]);
  });

  it('revalidates each candidate and keeps a file that becomes held before deletion', async () => {
    const candidate = oldFile('late.png');
    db.afterFirstHolderRead = () => {
      db.integrationRows.push({ id: 'late', picture: `${FRONTEND_URL}/uploads/late.png`, deletedAt: null });
    };

    const result = await makeSweep().run({ mode: 'apply', olderThanDays: 30 });

    expect(result.files).toEqual([{ path: realpathSync(candidate), bytes: 6, deleted: false }]);
    expect(existsSync(candidate)).toBe(true);
    expect(result.errors).toEqual([expect.stringContaining('became live')]);
  });

  it('does not follow a candidate parent replaced by a symlink before deletion', async () => {
    const candidate = oldFile('swapped/orphan.bin', 'inside');
    const canonicalCandidate = realpathSync(candidate);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const external = join(outside, 'orphan.bin');
    writeFileSync(external, 'inside');
    db.afterFirstHolderRead = () => {
      rmSync(join(uploads, 'swapped'), { recursive: true });
      symlinkSync(outside, join(uploads, 'swapped'));
    };

    const result = await makeSweep().run({ mode: 'apply', olderThanDays: 30 });

    expect(result.files).toEqual([
      { path: canonicalCandidate, bytes: 6, deleted: false },
    ]);
    expect(readFileSync(external, 'utf8')).toBe('inside');
    expect(result.errors).toEqual([expect.stringContaining('unsafe')]);
  });

  it('deletes one revalidated file without deleting directories', async () => {
    const orphan = oldFile('nested/orphan.bin', '1234');
    const canonicalOrphan = realpathSync(orphan);

    const result = await makeSweep().run({ mode: 'apply', olderThanDays: 30 });

    expect(result.files).toEqual([{ path: canonicalOrphan, bytes: 4, deleted: true }]);
    expect(result.bytesFreed).toBe(4);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(uploads, 'nested'))).toBe(true);
    expect(readdirSync(join(uploads, '.retention', 'quarantine'))).toEqual([]);
  });
});
