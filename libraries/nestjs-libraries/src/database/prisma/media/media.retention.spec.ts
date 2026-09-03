import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  collectMediaReferences,
  collectScalarMediaReferences,
  normalizeMediaReference,
  parseMediaReferences,
  recoveryAction,
  replaceMediaReference,
  toLocalUploadPath,
} from './media.retention';
import { Prisma } from '@prisma/client';

const mediaModel = Prisma.dmmf.datamodel.models.find(
  (model) => model.name === 'Media'
);

function mediaField(name: string) {
  return mediaModel?.fields.find((field) => field.name === name);
}

describe('Media retention schema', () => {
  it('defines ACTIVE, STAGED, and PURGED lifecycle states', () => {
    const retentionState = Prisma.dmmf.datamodel.enums.find(
      (schemaEnum) => schemaEnum.name === 'MediaRetentionState'
    );

    expect(retentionState?.values.map((value) => value.name)).toEqual([
      'ACTIVE',
      'STAGED',
      'PURGED',
    ]);
  });

  it('creates active media by default without archive or purge metadata', () => {
    expect(mediaField('retentionState')).toEqual(
      expect.objectContaining({
        type: 'MediaRetentionState',
        isRequired: true,
        default: 'ACTIVE',
      })
    );
    expect(mediaField('archivePreviewPath')).toEqual(
      expect.objectContaining({ type: 'String', isRequired: false })
    );
    expect(mediaField('originalPurgedAt')).toEqual(
      expect.objectContaining({ type: 'DateTime', isRequired: false })
    );
  });

  it('indexes retention state with creation time', () => {
    const schema = readFileSync(
      resolve(__dirname, '../schema.prisma'),
      'utf8'
    );
    const mediaSchema = schema.match(/model Media \{[\s\S]*?\n\}/)?.[0];

    expect(mediaSchema).toContain('@@index([retentionState, createdAt])');
  });
});

describe('Media retention helpers', () => {
  let fixtureRoot: string;
  let uploadDirectory: string;
  const frontendUrl = 'https://postiz.42factory.ru';

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'postiz-media-retention-'));
    uploadDirectory = join(fixtureRoot, 'uploads');
    mkdirSync(join(uploadDirectory, '2026', '09'), { recursive: true });
    writeFileSync(join(uploadDirectory, '2026', '09', 'a.png'), 'image');
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  describe('toLocalUploadPath', () => {
    it('maps an existing same-origin upload URL to its canonical local file', () => {
      expect(
        toLocalUploadPath(
          'https://postiz.42factory.ru/uploads/2026/09/a.png',
          'https://postiz.42factory.ru',
          uploadDirectory
        )
      ).toBe(realpathSync(join(uploadDirectory, '2026', '09', 'a.png')));
    });

    it('rejects a cross-origin URL', () => {
      expect(
        toLocalUploadPath(
          'https://cdn.example/a.png',
          frontendUrl,
          uploadDirectory
        )
      ).toBeNull();
    });

    it('rejects encoded traversal outside the upload URL prefix', () => {
      expect(
        toLocalUploadPath(
          'https://postiz.42factory.ru/uploads/%2e%2e/.env',
          frontendUrl,
          uploadDirectory
        )
      ).toBeNull();
    });

    it('rejects a candidate that escapes the canonical upload root', () => {
      const secretPath = join(fixtureRoot, 'secret.txt');
      writeFileSync(secretPath, 'secret');

      expect(
        toLocalUploadPath(
          'https://postiz.42factory.ru/uploads/2026%2f..%2f..%2fsecret.txt',
          frontendUrl,
          uploadDirectory
        )
      ).toBeNull();
    });

    it('rejects symlinks without modifying either file', () => {
      const originalPath = join(uploadDirectory, '2026', '09', 'a.png');
      const symlinkPath = join(uploadDirectory, '2026', '09', 'link.png');
      symlinkSync(originalPath, symlinkPath);

      expect(
        toLocalUploadPath(
          'https://postiz.42factory.ru/uploads/2026/09/link.png',
          frontendUrl,
          uploadDirectory
        )
      ).toBeNull();
      expect(readFileSync(originalPath, 'utf8')).toBe('image');
      expect(readFileSync(symlinkPath, 'utf8')).toBe('image');
    });

    it('rejects missing files and directories', () => {
      expect(
        toLocalUploadPath(
          'https://postiz.42factory.ru/uploads/2026/09/missing.png',
          frontendUrl,
          uploadDirectory
        )
      ).toBeNull();
      expect(
        toLocalUploadPath(
          'https://postiz.42factory.ru/uploads/2026/09',
          frontendUrl,
          uploadDirectory
        )
      ).toBeNull();
    });
  });

  describe('collectMediaReferences', () => {
    it('recursively collects IDs and normalized HTTP URLs', () => {
      const references = collectMediaReferences(
        JSON.stringify({
          direct: { id: 'm1' },
          nested: [
            {
              media: {
                id: 'm2',
                path: 'HTTPS://POSTIZ.42FACTORY.RU:443/uploads/a.png?size=2#crop',
              },
            },
          ],
        })
      );

      expect(references).toEqual(
        new Set([
          'm1',
          'm2',
          'https://postiz.42factory.ru/uploads/a.png',
        ])
      );
    });

    it.each([
      ['Post.image', [{ id: 'post-image-id' }], 'post-image-id'],
      [
        'Post.settings',
        { provider: { media: { id: 'post-settings-id' } } },
        'post-settings-id',
      ],
      ['Sets.content', { rows: [{ id: 'sets-content-id' }] }, 'sets-content-id'],
      [
        'Integration.picture',
        'https://postiz.42factory.ru/uploads/integration.png',
        'https://postiz.42factory.ru/uploads/integration.png',
      ],
      [
        'Media.thumbnail',
        'https://postiz.42factory.ru/uploads/thumbnail.png',
        'https://postiz.42factory.ru/uploads/thumbnail.png',
      ],
      [
        'Media.archivePreviewPath',
        'https://postiz.42factory.ru/uploads/.retention/archive.webp',
        'https://postiz.42factory.ru/uploads/.retention/archive.webp',
      ],
      ['User.pictureId', 'user-picture-id', 'user-picture-id'],
      ['OAuthApp.pictureId', 'oauth-picture-id', 'oauth-picture-id'],
      ['SocialMediaAgency.logoId', 'agency-logo-id', 'agency-logo-id'],
    ])('collects the %s holder so its file remains retained', (_, value, expected) => {
      expect(collectMediaReferences(JSON.stringify(value))).toContain(expected);
    });

    it.each([
      [
        'Integration.picture',
        'HTTPS://POSTIZ.42FACTORY.RU:443/uploads/integration.png?size=2#crop',
        'https://postiz.42factory.ru/uploads/integration.png',
      ],
      ['User.pictureId', 'user-picture-id', 'user-picture-id'],
      ['OAuthApp.pictureId', 'oauth-picture-id', 'oauth-picture-id'],
      ['SocialMediaAgency.logoId', 'agency-logo-id', 'agency-logo-id'],
      [
        'Media.thumbnail',
        'https://postiz.42factory.ru/uploads/thumbnail.png',
        'https://postiz.42factory.ru/uploads/thumbnail.png',
      ],
      [
        'Media.archivePreviewPath',
        'https://postiz.42factory.ru/uploads/.retention/archive.webp',
        'https://postiz.42factory.ru/uploads/.retention/archive.webp',
      ],
    ])('collects raw %s scalar columns', (_, value, expected) => {
      expect(collectScalarMediaReferences(value)).toEqual(new Set([expected]));
    });

    it('does not reinterpret malformed object or array JSON as a scalar ID', () => {
      expect(collectScalarMediaReferences('  {\"id\":')).toEqual(new Set());
      expect(collectScalarMediaReferences(' [\"m1\"')).toEqual(new Set());
    });

    it('distinguishes valid empty JSON from malformed JSON', () => {
      expect(parseMediaReferences('{}')).toEqual({
        references: new Set(),
        valid: true,
      });
      expect(parseMediaReferences('{\"id\":')).toEqual({
        references: new Set(),
        valid: false,
      });
    });

    it.each([
      [
        '[\"HTTPS://POSTIZ.42FACTORY.RU:443/uploads/a.png?stored=1#stored\"]',
        'https://postiz.42factory.ru/uploads/a.png?probe=1#probe',
      ],
      [
        '[\"https://postiz.42factory.ru/uploads/a.png\"]',
        'HTTPS://POSTIZ.42FACTORY.RU:443/uploads/a.png?probe=1#probe',
      ],
    ])('normalizes both collected and probed URL references', (json, probe) => {
      expect(
        collectMediaReferences(json).has(normalizeMediaReference(probe))
      ).toBe(true);
    });

    it('returns an empty set for malformed JSON used by blocking queries', () => {
      expect(collectMediaReferences('{"id":')).toEqual(new Set());
    });
  });

  describe('replaceMediaReference', () => {
    it('updates path and URL only on recursively nested objects with the requested ID', () => {
      const previewUrl =
        'https://postiz.42factory.ru/uploads/.retention/m1.webp';
      const json =
        '[{"id":"m1","path":"old","url":"old"},{"id":"m2","path":"keep"},{"nested":{"id":"m1","path":"nested-old","url":"nested-old"}},{"mediaId":"m1","path":"not-an-id"}]';

      expect(replaceMediaReference(json, 'm1', previewUrl)).toBe(
        '[{"id":"m1","path":"https://postiz.42factory.ru/uploads/.retention/m1.webp","url":"https://postiz.42factory.ru/uploads/.retention/m1.webp"},{"id":"m2","path":"keep"},{"nested":{"id":"m1","path":"https://postiz.42factory.ru/uploads/.retention/m1.webp","url":"https://postiz.42factory.ru/uploads/.retention/m1.webp"}},{"mediaId":"m1","path":"not-an-id"}]'
      );
    });

    it('adds both persisted URL fields when a matching entry has only path', () => {
      const previewUrl =
        'https://postiz.42factory.ru/uploads/.retention/m1.webp';

      expect(
        replaceMediaReference('[{\"id\":\"m1\",\"path\":\"old\"}]', 'm1', previewUrl)
      ).toBe(
        '[{\"id\":\"m1\",\"path\":\"https://postiz.42factory.ru/uploads/.retention/m1.webp\",\"url\":\"https://postiz.42factory.ru/uploads/.retention/m1.webp\"}]'
      );
    });

    it('throws a SyntaxError for malformed JSON before cleanup mutation', () => {
      expect(() =>
        replaceMediaReference(
          '{"id":',
          'm1',
          'https://postiz.42factory.ru/uploads/.retention/m1.webp'
        )
      ).toThrow(SyntaxError);
    });
  });

  describe('recoveryAction', () => {
    it.each([
      [true, true, 'purge'],
      [true, false, 'finalize'],
      [false, true, 'regenerate'],
      [false, false, 'error'],
    ] as const)(
      'returns %s/%s as %s',
      (previewExists, originalExists, expected) => {
        expect(recoveryAction({ previewExists, originalExists })).toBe(expected);
      }
    );
  });
});
