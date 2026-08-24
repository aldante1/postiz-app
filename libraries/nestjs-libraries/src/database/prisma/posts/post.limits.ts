import { weightedLength } from '@gitroom/helpers/utils/count.length';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import type { SocialProvider } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

export const providerVisibleLength = (
  provider: Pick<SocialProvider, 'visibleLength'>,
  content: string,
  isX: boolean
): number => {
  if (provider.visibleLength) {
    return provider.visibleLength(content);
  }

  const strip = stripHtmlValidation('normal', content || '', true);
  const weighted = isX ? weightedLength(strip) : strip.length;

  return weighted > strip.length ? weighted : strip.length;
};

export const isTooLong = (
  provider: Pick<SocialProvider, 'visibleLength' | 'maxLength'>,
  content: string,
  hasMedia: boolean,
  additionalSettings: unknown,
  isX: boolean
): boolean => {
  const length = providerVisibleLength(provider, content, isX);
  const maximumCharacters =
    provider.maxLength(additionalSettings, hasMedia) || 1000000;

  return length > maximumCharacters;
};
