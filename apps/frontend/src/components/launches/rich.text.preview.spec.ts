import { prepareRichPreviewHtml } from './rich.text.preview';

const richContent =
  '<strong>Выберите режим</strong><pre><code>Сделайте портрет в стиле постера</code></pre><p>→ <a href="https://app.leantech.ai/?utm_source=max">Повторить на сайте</a></p>';

describe('prepareRichPreviewHtml', () => {
  it('preserves the heading, prompt block, and CTA', () => {
    const preview = prepareRichPreviewHtml(richContent, 4_000);

    expect(preview.content).toContain('<strong>Выберите режим</strong>');
    expect(preview.content).toContain(
      '<pre><code>Сделайте портрет в стиле постера</code></pre>'
    );
    expect(preview.content).toContain(
      'href="https://app.leantech.ai/?utm_source=max"'
    );
  });

  it('keeps tags balanced when the preview is truncated', () => {
    expect(
      prepareRichPreviewHtml('<pre><code>abcdefghij</code></pre>', 5)
    ).toEqual({
      content: '<pre><code>abcde</code></pre>',
      overflowHtml: 'fghij',
    });
  });
});
