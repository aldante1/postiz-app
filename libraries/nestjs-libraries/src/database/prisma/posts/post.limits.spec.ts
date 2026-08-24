import { weightedLength } from '@gitroom/helpers/utils/count.length';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import type { SocialProvider } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  isTooLong,
  providerVisibleLength,
} from './post.limits';

type LengthProvider = Pick<SocialProvider, 'visibleLength' | 'maxLength'>;
type LegacyLengthProvider = Pick<SocialProvider, 'visibleLength'>;

const mediaAwareProvider = {
  visibleLength: (content: string) => content.length,
  maxLength: (_additionalSettings?: unknown, hasMedia?: boolean) =>
    hasMedia ? 1024 : 4096,
} satisfies LengthProvider;

const legacyProvider = {} satisfies LegacyLengthProvider;

describe('post limits', () => {
  it('uses provider visible length with media-aware max length', () => {
    expect(
      isTooLong(mediaAwareProvider, 'x'.repeat(1025), true, [], false)
    ).toBe(true);
    expect(
      isTooLong(mediaAwareProvider, 'x'.repeat(1025), false, [], false)
    ).toBe(false);
    expect(
      isTooLong(mediaAwareProvider, 'x'.repeat(1024), true, [], false)
    ).toBe(false);
    expect(
      isTooLong(mediaAwareProvider, 'x'.repeat(4096), false, [], false)
    ).toBe(false);
    expect(
      isTooLong(mediaAwareProvider, 'x'.repeat(4097), false, [], false)
    ).toBe(true);
  });

  it('keeps legacy stripHtmlValidation length for providers without visibleLength', () => {
    const content = '<p><strong>Hello</strong> <u>world</u></p>';
    const stripped = stripHtmlValidation('normal', content, true);

    expect(providerVisibleLength(legacyProvider, content, false)).toBe(
      stripped.length
    );
  });

  it('uses weightedLength for X providers without visibleLength', () => {
    const content = '<p>https://example.com/a</p>';
    const stripped = stripHtmlValidation('normal', content, true);
    const expected = Math.max(weightedLength(stripped), stripped.length);

    expect(providerVisibleLength(legacyProvider, content, true)).toBe(expected);
    expect(expected).toBeGreaterThan(stripped.length);
  });

  it('counts formatted Telegram content by provider-visible letters instead of legacy markup', () => {
    const content = '<strong>жирный</strong>!';
    const visibleText = 'жирный!';
    const provider = {
      visibleLength: () => visibleText.length,
      maxLength: () => 1000000,
    } satisfies LengthProvider;

    expect(providerVisibleLength(provider, content, false)).toBe(7);
    expect(providerVisibleLength(provider, content, false)).toBe(
      visibleText.length
    );
    expect(providerVisibleLength(legacyProvider, content, false)).toBeGreaterThan(
      visibleText.length
    );
  });

  it('shows legacy bold pseudographics are longer than provider-visible text', () => {
    const content = '<p><strong>bold123</strong></p>';
    const visibleText = 'bold123';
    const provider = {
      visibleLength: () => visibleText.length,
      maxLength: () => 1000000,
    } satisfies LengthProvider;

    expect(providerVisibleLength(provider, content, false)).toBe(7);
    expect(providerVisibleLength(legacyProvider, content, false)).toBeGreaterThan(
      visibleText.length
    );
  });
});
