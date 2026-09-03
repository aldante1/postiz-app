import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
