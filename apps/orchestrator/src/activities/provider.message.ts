import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import type { SocialProvider } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

// Providers that sanitize on their own (Telegram) must receive the editor HTML
// untouched: the shared pipeline strips their tags and un-escapes entities.
export const buildProviderMessage = (
  provider: Pick<SocialProvider, 'editor' | 'rawEditorContent' | 'mentionFormat'>,
  content: string
): string => {
  const value = content ?? '';

  if (provider.rawEditorContent === true) {
    return value;
  }

  return stripHtmlValidation(
    provider.editor,
    value,
    true,
    false,
    !/<\/?[a-z][\s\S]*>/i.test(value),
    provider.mentionFormat
  );
};
