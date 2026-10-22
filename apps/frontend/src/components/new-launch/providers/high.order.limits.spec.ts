/**
 * @jest-environment node
 */
import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  telegramLimit,
} from '@gitroom/helpers/utils/telegram.limits';
import { MAX_TEXT_LIMIT } from '@gitroom/helpers/utils/max.limits';
import {
  pickCharLimit,
  resolveCharLimits,
  resolveMaxCharacters,
} from './max.characters';

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

describe('resolveCharLimits / pickCharLimit', () => {
  const telegram = (_settings: unknown, hasMedia: boolean) =>
    telegramLimit(hasMedia);

  it('gives each thread message its own Telegram limit by its own media', () => {
    // Альбом с подписью и промпт вторым сообщением без вложений: 1024 и 4096,
    // а не 1024 на оба из-за медиа первого сообщения.
    const limits = resolveCharLimits(telegram, []);
    expect(pickCharLimit(limits, true)).toBe(TELEGRAM_CAPTION_LIMIT);
    expect(pickCharLimit(limits, false)).toBe(TELEGRAM_TEXT_LIMIT);
  });

  it('keeps a numeric limit equal with and without media', () => {
    const limits = resolveCharLimits(MAX_TEXT_LIMIT, []);
    expect(pickCharLimit(limits, true)).toBe(4000);
    expect(pickCharLimit(limits, false)).toBe(4000);
  });

  it('treats a missing limit as zero, like the editor pill did', () => {
    expect(resolveCharLimits(undefined, [])).toBeUndefined();
    expect(pickCharLimit(undefined, true)).toBe(0);
  });
});

describe('telegramLimit', () => {
  it('keeps Telegram text and caption constants at Bot API limits', () => {
    expect(TELEGRAM_TEXT_LIMIT).toBe(4096);
    expect(TELEGRAM_CAPTION_LIMIT).toBe(1024);
  });
});
