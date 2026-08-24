/**
 * @jest-environment node
 */

import {
  TelegramBlockquote,
  TelegramSpoiler,
  interlockExtensions,
  telegramExtensions,
} from './telegram.marks';

describe('Telegram editor extensions', () => {
  it('returns Telegram formatting extensions without non-Telegram interlocks', () => {
    const names = telegramExtensions().map((extension) => extension.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'italic',
        'strike',
        'code',
        'codeBlock',
        'blockquote',
        'telegramSpoiler',
      ])
    );
    expect(names).not.toContain('preventBoldWithUnderline');
    expect(names).not.toContain('preventUnderlineWithUnderline');
  });

  it('returns only the legacy bold/underline interlocks', () => {
    expect(interlockExtensions().map((extension) => extension.name)).toEqual([
      'preventBoldWithUnderline',
      'preventUnderlineWithUnderline',
    ]);
  });

  it('parses Telegram spoiler tags', () => {
    const parseHTML = TelegramSpoiler.config.parseHTML;

    expect(TelegramSpoiler.name).toBe('telegramSpoiler');
    expect(
      parseHTML?.call({
        name: 'telegramSpoiler',
        options: {},
        storage: {},
        parent: {},
      })
    ).toEqual(expect.arrayContaining([expect.objectContaining({ tag: 'tg-spoiler' })]));
  });

  it('renders expandable blockquote only when the attribute is enabled', () => {
    const addAttributes = TelegramBlockquote.config.addAttributes;
    const attributes = addAttributes?.call({
      name: 'blockquote',
      options: { HTMLAttributes: {} },
      storage: {},
      parent: {},
    });
    const expandable = attributes?.expandable;

    expect(expandable?.renderHTML?.({ expandable: true })).toEqual({
      expandable: '',
    });
    expect(expandable?.renderHTML?.({ expandable: false })).toEqual({});
  });
});
