/**
 * @jest-environment node
 */
import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  telegramLimit,
} from '@gitroom/helpers/utils/telegram.limits';
import { MAX_TEXT_LIMIT } from '@gitroom/helpers/utils/max.limits';
import { resolveMaxCharacters } from './max.characters';

describe('resolveMaxCharacters', () => {
  it('keeps a numeric limit independent of media', () => {
    expect(resolveMaxCharacters(4096, [], true)).toBe(4096);
  });

  it('keeps an undefined limit undefined', () => {
    expect(resolveMaxCharacters(undefined, [], false)).toBeUndefined();
  });

  it('resolves Telegram text and media limits from media presence', () => {
    const limit = (_settings: unknown, hasMedia: boolean) => {
      const resolvedLimit = telegramLimit(hasMedia);
      return resolvedLimit;
    };

    expect(resolveMaxCharacters(limit, [], false)).toBe(4096);
    expect(resolveMaxCharacters(limit, [], true)).toBe(1024);
  });

  it('keeps MAX text limit independent of media presence', () => {
    expect(resolveMaxCharacters(MAX_TEXT_LIMIT, [], false)).toBe(4000);
    expect(resolveMaxCharacters(MAX_TEXT_LIMIT, [], true)).toBe(4000);
  });

  it('passes settings to a dynamic limit as the first argument', () => {
    const settings = [{ channel: 'main' }];
    const limit = jest.fn((receivedSettings: unknown, hasMedia: boolean) => {
      expect(receivedSettings).toBe(settings);
      expect(hasMedia).toBe(true);
      return 1234;
    });

    expect(resolveMaxCharacters(limit, settings, true)).toBe(1234);
    expect(limit).toHaveBeenCalledWith(settings, true);
  });
});

describe('telegramLimit', () => {
  it('keeps Telegram text and caption constants at Bot API limits', () => {
    expect(TELEGRAM_TEXT_LIMIT).toBe(4096);
    expect(TELEGRAM_CAPTION_LIMIT).toBe(1024);
  });
});
