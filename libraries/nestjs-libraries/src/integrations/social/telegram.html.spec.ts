import {
  TelegramFormatError,
  telegramVisibleLength,
  toTelegramHtml,
} from './telegram.html';

const allowedTagCases: Array<[string, string, string, number]> = [
  ['b', '<p><b>bold</b></p>', '<b>bold</b>', 4],
  ['i', '<p><i>italic</i></p>', '<i>italic</i>', 6],
  ['u', '<p><u>underline</u></p>', '<u>underline</u>', 9],
  ['s', '<p><s>strike</s></p>', '<s>strike</s>', 6],
  [
    'a',
    '<p><a href="https://example.com">link</a></p>',
    '<a href="https://example.com">link</a>',
    4,
  ],
  ['code', '<p><code>code</code></p>', '<code>code</code>', 4],
  ['pre', '<pre>block</pre>', '<pre>block</pre>', 5],
  [
    'blockquote',
    '<blockquote>quote</blockquote>',
    '<blockquote>quote</blockquote>',
    5,
  ],
  [
    'tg-spoiler',
    '<p><tg-spoiler>secret</tg-spoiler></p>',
    '<tg-spoiler>secret</tg-spoiler>',
    6,
  ],
];

describe('Telegram HTML formatter contract', () => {
  it.each(allowedTagCases)('preserves allowed tag %s', (_tag, input, html, length) => {
    expect(toTelegramHtml(input)).toEqual({ html, length });
  });

  it('preserves nested bold, italic, underline, strike and spoiler together', () => {
    expect(
      toTelegramHtml(
        '<p><b><i><u><s><tg-spoiler>secret</tg-spoiler></s></u></i></b></p>'
      )
    ).toEqual({
      html: '<b><i><u><s><tg-spoiler>secret</tg-spoiler></s></u></i></b>',
      length: 6,
    });
  });

  it('normalizes strong, em, strike and del tags', () => {
    expect(
      toTelegramHtml(
        '<p><strong>bold</strong><em>italic</em><strike>strike</strike><del>del</del></p>'
      )
    ).toEqual({
      html: '<b>bold</b><i>italic</i><s>strike</s><s>del</s>',
      length: 19,
    });
  });

  it('allows safe link protocols and strips link attributes', () => {
    expect(
      toTelegramHtml(
        '<p><a href="https://example.com/path?a=1&amp;b=2" target="_blank" rel="noreferrer" class="external">site</a></p>'
      )
    ).toEqual({
      html: '<a href="https://example.com/path?a=1&amp;b=2">site</a>',
      length: 4,
    });

    expect(toTelegramHtml('<p><a href="tg://resolve?domain=postiz">tg</a></p>'))
      .toEqual({
        html: '<a href="tg://resolve?domain=postiz">tg</a>',
        length: 2,
      });
  });

  it('throws TelegramFormatError for javascript links without leaking the post text', () => {
    const error = captureError(() =>
      toTelegramHtml('<p><a href="javascript:alert(1)">secret post text</a></p>')
    );

    expect(error).toBeInstanceOf(TelegramFormatError);
    expect(errorMessage(error).includes('javascript')).toBe(true);
    expect(errorMessage(error).includes('javascript:alert(1)')).toBe(false);
    expect(errorMessage(error).includes('secret post text')).toBe(false);
  });

  it('unwraps links with empty href and keeps their text', () => {
    expect(toTelegramHtml('<p><a href="" class="external">plain</a></p>'))
      .toEqual({ html: 'plain', length: 5 });
  });

  it('escapes inline code and pre code text once and strips code attributes', () => {
    expect(
      toTelegramHtml('<p><code>5 &lt; 7 &amp;&amp; "x" &gt; 1</code></p>')
    ).toEqual({
      html: '<code>5 &lt; 7 &amp;&amp; "x" &gt; 1</code>',
      length: 16,
    });

    expect(
      toTelegramHtml(
        '<pre><code class="language-ts">if (a &lt; b &amp;&amp; c &gt; d) return "x";</code></pre>'
      )
    ).toEqual({
      html: '<pre><code>if (a &lt; b &amp;&amp; c &gt; d) return "x";</code></pre>',
      length: 31,
    });
  });

  it('throws TelegramFormatError for pre inside pre', () => {
    expect(captureError(() => toTelegramHtml('<pre>outer<pre>inner</pre></pre>')))
      .toBeInstanceOf(TelegramFormatError);
  });

  it('formats regular and expandable blockquotes without unsupported attributes', () => {
    expect(toTelegramHtml('<blockquote class="quote">quote</blockquote>')).toEqual({
      html: '<blockquote>quote</blockquote>',
      length: 5,
    });

    expect(
      toTelegramHtml('<blockquote expandable="" class="quote">more</blockquote>')
    ).toEqual({
      html: '<blockquote expandable>more</blockquote>',
      length: 4,
    });
  });

  it('converts paragraphs, empty paragraphs and br tags to visible newlines', () => {
    expect(toTelegramHtml('<p>one</p><p>two</p>')).toEqual({
      html: 'one\ntwo',
      length: 7,
    });

    expect(toTelegramHtml('<p>one</p><p></p><p>two</p>')).toEqual({
      html: 'one\n\ntwo',
      length: 8,
    });

    expect(toTelegramHtml('<p>one<br>two</p>')).toEqual({
      html: 'one\ntwo',
      length: 7,
    });
  });

  it('strips unsupported block tags and mention spans while preserving visible text', () => {
    expect(toTelegramHtml('<h1>Title</h1><div>Box</div>')).toEqual({
      html: 'Title\nBox',
      length: 9,
    });

    expect(toTelegramHtml('<ul><li>One</li><li>Two</li></ul>')).toEqual({
      html: 'One\nTwo',
      length: 7,
    });

    expect(
      toTelegramHtml(
        '<p><span data-mention-id="42" data-mention-label="Danil">@danil</span></p>'
      )
    ).toEqual({ html: '@danil', length: 6 });
  });

  it('escapes text nodes exactly once', () => {
    expect(toTelegramHtml('<p>5 &lt; 7 &amp;&amp; "x" &gt; 1</p>')).toEqual({
      html: '5 &lt; 7 &amp;&amp; "x" &gt; 1',
      length: 16,
    });
  });

  it('counts visible UTF-16 length independently of markup volume', () => {
    expect(toTelegramHtml('<p><strong>жирный</strong></p>')).toEqual({
      html: '<b>жирный</b>',
      length: 6,
    });

    expect(
      toTelegramHtml(
        '<p><b><i><u><s><tg-spoiler>жирный</tg-spoiler></s></u></i></b></p>'
      ).length
    ).toBe(6);
  });

  it('returns visible length instead of throwing for unsafe links', () => {
    expect(
      telegramVisibleLength(
        '<p>before <a href="javascript:alert(1)">visible</a> after</p>'
      )
    ).toBe(20);
  });
});

const captureError = (action: () => unknown): unknown => {
  try {
    action();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : '';
