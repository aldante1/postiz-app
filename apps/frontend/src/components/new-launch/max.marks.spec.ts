/**
 * @jest-environment node
 */

import { MaxHighlight, maxExtensions } from './max.marks';

describe('MAX editor extensions', () => {
  it('returns MAX formatting extensions without Telegram-only marks or interlocks', () => {
    const names = maxExtensions().map((extension) => extension.name);

    expect(names).toEqual([
      'italic',
      'strike',
      'code',
      'codeBlock',
      'maxHighlight',
    ]);
    expect(names).not.toContain('telegramSpoiler');
    expect(names).not.toContain('telegramBlockquote');
    expect(names).not.toContain('preventBoldWithUnderline');
    expect(names).not.toContain('preventUnderlineWithUnderline');
  });

  it('parses and renders MAX highlight tags', () => {
    const parseHTML = MaxHighlight.config.parseHTML;
    const renderHTML = MaxHighlight.config.renderHTML;

    expect(MaxHighlight.name).toBe('maxHighlight');
    expect(
      parseHTML?.call({
        name: 'maxHighlight',
        options: {},
        storage: {},
        parent: {},
      })
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ tag: 'mark' })])
    );
    expect(
      renderHTML?.call(
        {
          name: 'maxHighlight',
          options: {},
          storage: {},
          parent: {},
        },
        { HTMLAttributes: { class: 'selection' } }
      )
    ).toEqual(['mark', { class: 'selection' }, 0]);
  });

  it('omits blockquote entirely: MAX never renders a quote', () => {
    const names = maxExtensions().map((extension) => extension.name);

    expect(names).not.toContain('blockquote');
  });

  it('declares MAX highlight commands', () => {
    const addCommands = MaxHighlight.config.addCommands;
    const commands = addCommands?.call({
      name: 'maxHighlight',
      options: {},
      storage: {},
      parent: {},
    });

    expect(commands).toEqual(
      expect.objectContaining({
        setMaxHighlight: expect.any(Function),
        unsetMaxHighlight: expect.any(Function),
        toggleMaxHighlight: expect.any(Function),
      })
    );
  });
});
