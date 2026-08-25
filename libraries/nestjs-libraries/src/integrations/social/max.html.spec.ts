import { MaxFormatError, maxVisibleLength, toMaxHtml } from './max.html';

const allowedTagCases: Array<[string, string, string, number]> = [
  ['b', '<p><b>bold</b></p>', '<b>bold</b>', 4],
  ['strong', '<p><strong>bold</strong></p>', '<b>bold</b>', 4],
  ['i', '<p><i>italic</i></p>', '<i>italic</i>', 6],
  ['em', '<p><em>italic</em></p>', '<i>italic</i>', 6],
  ['u', '<p><u>underline</u></p>', '<u>underline</u>', 9],
  ['ins', '<p><ins>underline</ins></p>', '<u>underline</u>', 9],
  ['s', '<p><s>strike</s></p>', '<s>strike</s>', 6],
  ['del', '<p><del>strike</del></p>', '<s>strike</s>', 6],
  ['strike', '<p><strike>strike</strike></p>', '<s>strike</s>', 6],
  ['code', '<p><code>code</code></p>', '<code>code</code>', 4],
  ['pre', '<pre>block</pre>', '<pre>block</pre>', 5],
  ['mark', '<p><mark>highlight</mark></p>', '<mark>highlight</mark>', 9],
  ['h1', '<h1>Title</h1>', '<h1>Title</h1>', 5],
  ['h2', '<h2>Title</h2>', '<h1>Title</h1>', 5],
  ['h3', '<h3>Title</h3>', '<h1>Title</h1>', 5],
];

describe('MAX HTML formatter contract', () => {
  it.each(allowedTagCases)('preserves supported MAX tag %s', (_tag, input, html, length) => {
    expect(toMaxHtml(input)).toEqual({ html, length });
  });

  it('keeps nested supported inline tags and counts only visible text', () => {
    expect(toMaxHtml('<p><strong><em><ins><del><mark>текст</mark></del></ins></em></strong></p>')).toEqual({
      html: '<b><i><u><s><mark>текст</mark></s></u></i></b>',
      length: 5,
    });
  });

  it('strips unsupported attributes from links and escapes the href once', () => {
    expect(toMaxHtml('<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://x.ru/?a=1&amp;b=2">текст</a></p>')).toEqual({
      html: '<a href="https://x.ru/?a=1&amp;b=2">текст</a>',
      length: 5,
    });

    expect(toMaxHtml('<p><a href="https://x.ru/?q=&quot;">quote</a></p>')).toEqual({
      html: '<a href="https://x.ru/?q=&quot;">quote</a>',
      length: 5,
    });
  });

  it.each([
    ['https', '<a href="https://example.com">https</a>'],
    ['http', '<a href="http://example.com">http</a>'],
    ['mailto', '<a href="mailto:test@example.com">mail</a>'],
    ['tel', '<a href="tel:+79990000000">tel</a>'],
    ['max user mention', '<a href="max://user/123">max</a>'],
  ])('allows %s links', (_case, link) => {
    expect(toMaxHtml(`<p>${link}</p>`).html).toBe(link);
  });

  it.each([
    ['javascript', '<p><a href="javascript:alert(1)">secret post text</a></p>'],
    ['data', '<p><a href="data:text/plain,secret">secret post text</a></p>'],
    ['unsupported max deep link', '<p><a href="max://chat/1">secret post text</a></p>'],
  ])('throws MaxFormatError for %s links without leaking the URL or post text', (_case, input) => {
    const error = captureError(() => toMaxHtml(input));

    expect(error).toBeInstanceOf(MaxFormatError);
    expect(errorMessage(error)).toContain('Unsupported MAX link protocol:');
    expect(errorMessage(error)).not.toContain('alert(1)');
    expect(errorMessage(error)).not.toContain('secret post text');
  });

  it('throws MaxFormatError when href exceeds 2048 characters without leaking the URL', () => {
    const href = `https://example.com/${'x'.repeat(2049)}`;
    const error = captureError(() => toMaxHtml(`<p><a href="${href}">link</a></p>`));

    expect(error).toBeInstanceOf(MaxFormatError);
    expect(errorMessage(error)).toBe('MAX link URL exceeds 2048 characters.');
    expect(errorMessage(error)).not.toContain(href);
  });

  it('unwraps empty links and unsupported inline tags while preserving visible text', () => {
    expect(toMaxHtml('<p><a href="" class="external">plain</a></p>')).toEqual({
      html: 'plain',
      length: 5,
    });

    expect(toMaxHtml('<p><tg-spoiler>secret</tg-spoiler><span class="mention" data-mention-id="42" data-mention-label="Danil">@danil</span></p>')).toEqual({
      html: 'secret@danil',
      length: 12,
    });
  });

  it('escapes text nodes and code contents exactly once', () => {
    expect(toMaxHtml('<p>5 &lt; 7 &amp; да &gt; 3</p>')).toEqual({
      html: '5 &lt; 7 &amp; да &gt; 3',
      length: 14,
    });

    expect(toMaxHtml('<p><code>5 &lt; 7 &amp; да</code></p>')).toEqual({
      html: '<code>5 &lt; 7 &amp; да</code>',
      length: 10,
    });
  });

  it('formats paragraphs, divs and br tags as visible line breaks', () => {
    expect(toMaxHtml('<p>one<br>two</p><div>three</div>')).toEqual({
      html: 'one\ntwo\nthree',
      length: 13,
    });
  });

  it('keeps an intentionally empty paragraph as a blank line', () => {
    expect(toMaxHtml('<p>a</p><p></p><p>b</p>')).toEqual({
      html: 'a\n\nb',
      length: 4,
    });
  });

  it('keeps blank lines inside code blocks untouched', () => {
    expect(toMaxHtml('<pre><code>line1\n\nline3</code></pre>')).toEqual({
      html: '<pre><code>line1\n\nline3</code></pre>',
      length: 12,
    });
  });

  it('formats unordered lists from tiptap without duplicate paragraph line breaks', () => {
    expect(toMaxHtml('<ul><li><p>раз</p></li><li><p>два</p></li></ul>')).toEqual({
      html: '• раз\n• два',
      length: 11,
    });
  });

  it('formats ordered and nested lists with per-list numbering and two-space indentation', () => {
    const html = '1. one\n  • inner\n2. two';

    expect(toMaxHtml('<ol><li>one<ul><li>inner</li></ul></li><li>two</li></ol>')).toEqual({
      html,
      length: html.length,
    });
  });

  it('separates an unwrapped quote from the next block with a single line break', () => {
    expect(
      toMaxHtml('<blockquote><p>Цитата</p></blockquote><ul><li><p>пункт</p></li></ul>')
    ).toEqual({
      html: 'Цитата\n• пункт',
      length: 14,
    });
  });

  it('unwraps blockquote into plain text and normalizes h4-h6 to h1', () => {
    expect(toMaxHtml('<blockquote expandable="" class="quote">quote</blockquote><h4>Four</h4><h6>Six</h6>')).toEqual({
      html: 'quote\n<h1>Four</h1>\n<h1>Six</h1>',
      length: 14,
    });
  });

  it.each([
    ['code inside code', '<code>outer<code>inner</code></code>'],
    ['pre inside pre', '<pre>outer<pre>inner</pre></pre>'],
    ['pre inside code', '<code>outer<pre>inner</pre></code>'],
  ])('throws MaxFormatError for invalid %s nesting', (caseName, input) => {
    const error = captureError(() => toMaxHtml(input));

    expect(error).toBeInstanceOf(MaxFormatError);
    expect(errorMessage(error)).toBe(`Invalid MAX HTML nesting: ${caseName}`);
  });

  it('trims trailing line breaks from the final result', () => {
    expect(toMaxHtml('<p>one</p><p>two</p><br>')).toEqual({
      html: 'one\ntwo',
      length: 7,
    });
  });

  it('returns visible length without throwing for invalid links and invalid nesting', () => {
    expect(maxVisibleLength('<p>before <a href="javascript:alert(1)">visible</a> after</p>')).toBe(20);
    expect(maxVisibleLength('<code>outer<code>inner</code></code>')).toBe(10);
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
