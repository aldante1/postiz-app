import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import type { SocialProvider } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { buildProviderMessage } from './provider.message';

type ProviderMessageProvider = Pick<
  SocialProvider,
  'editor' | 'rawEditorContent' | 'mentionFormat'
>;

const provider = (
  overrides: Partial<ProviderMessageProvider> = {}
): ProviderMessageProvider => ({
  editor: 'html',
  ...overrides,
});

describe('buildProviderMessage', () => {
  it('passes raw editor HTML byte-for-byte to providers that sanitize themselves', () => {
    const content =
      '<p>Keep <i>italic</i> <tg-spoiler>secret</tg-spoiler> <blockquote expandable>quote</blockquote> &lt;not-a-tag&gt;</p>';

    const result = buildProviderMessage(
      provider({ rawEditorContent: true }),
      content
    );

    expect(result).toBe(content);
    expect(result).toContain('<i>italic</i>');
    expect(result).toContain('<tg-spoiler>secret</tg-spoiler>');
    expect(result).toContain('<blockquote expandable>quote</blockquote>');
    expect(result).toContain('&lt;not-a-tag&gt;');
    expect(result).not.toContain('<not-a-tag>');
  });

  it('keeps the previous html editor sanitization when raw content is not requested', () => {
    const content =
      '<p><i>italic</i> <tg-spoiler>secret</tg-spoiler> &lt;not-a-tag&gt;</p>';

    const result = buildProviderMessage(provider(), content);

    expect(result).toBe('<p>italic secret <not-a-tag></p>');
  });

  it('keeps normal editor output identical to the existing stripHtmlValidation call', () => {
    const content = '<p><strong>Bold</strong> <u>under</u></p>';

    expect(buildProviderMessage(provider({ editor: 'normal' }), content)).toBe(
      stripHtmlValidation('normal', content, true, false, false, undefined)
    );
  });

  it('uses plain mode for content without tags and leaves it unchanged', () => {
    const content = 'Fish &lt; chips &amp; salsa';

    expect(buildProviderMessage(provider(), content)).toBe(content);
  });

  it('normalizes empty and undefined content without throwing', () => {
    expect(buildProviderMessage(provider({ rawEditorContent: true }), '')).toBe('');
    expect(
      buildProviderMessage(
        provider({ rawEditorContent: true }),
        undefined as unknown as string
      )
    ).toBe('');
    expect(buildProviderMessage(provider(), '')).toBe('');
    expect(
      buildProviderMessage(provider(), undefined as unknown as string)
    ).toBe('');
  });
});
