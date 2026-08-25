// Санитайзер стоит в DTO создания поста (`PostContent.content`) — это единственные
// ворота между редактором и базой. Пока в его allowlist не было форматирующих тегов,
// тулбар Telegram и MAX рисовал курсив, код и цитату, а в канал уходил плоский
// текст: теги срезались до провайдера. Тест защищает именно состав ворот.
//
// Сам DOMPurify здесь не вызывается: `isomorphic-dompurify` тянет ESM-копии jsdom и
// parse5, которые ломают CommonJS-раннер jest. Фактическое поведение проверяется
// смоуком на живом образе (см. operations/postiz/README.md).
import {
  ALLOWED_ATTR,
  ALLOWED_TAGS,
  ALLOWED_URI_REGEXP,
} from './sanitize.post.allowlist';

describe('sanitizePostContent allowlist contract', () => {
  it.each([
    ['жирный', ['strong', 'b']],
    ['подчёркнутый', ['u', 'ins']],
    ['курсив', ['em', 'i']],
    ['зачёркнутый', ['s', 'del', 'strike']],
    ['моноширинный', ['code', 'pre']],
    ['выделение', ['mark']],
    ['цитата', ['blockquote']],
    ['спойлер Telegram', ['tg-spoiler']],
    ['списки', ['ul', 'ol', 'li']],
    ['заголовки', ['h1', 'h2', 'h3']],
    ['ссылка и абзацы', ['a', 'p', 'br']],
  ])('пропускает теги формата %s', (_name, tags) => {
    for (const tag of tags) {
      expect(ALLOWED_TAGS).toContain(tag);
    }
  });

  it.each(['script', 'iframe', 'style', 'object', 'embed', 'form', 'input'])(
    'не пропускает опасный тег %s',
    (tag) => {
      expect(ALLOWED_TAGS).not.toContain(tag);
    }
  );

  it('пропускает expandable для сворачиваемой цитаты Telegram', () => {
    expect(ALLOWED_ATTR).toContain('expandable');
  });

  it.each(['onclick', 'onerror', 'onload', 'style', 'srcdoc'])(
    'не пропускает атрибут %s',
    (attribute) => {
      expect(ALLOWED_ATTR).not.toContain(attribute);
    }
  );

  it.each([
    ['https', 'https://leantech.ru/?a=1&b=2'],
    ['http', 'http://leantech.ru'],
    ['mailto', 'mailto:hi@leantech.ru'],
    ['tel', 'tel:+79990000000'],
    ['telegram', 'tg://resolve?domain=leantech'],
    ['упоминание MAX', 'max://user/1234567'],
    ['относительная ссылка', '/pricing'],
    ['якорь', '#faq'],
  ])('разрешает схему %s', (_name, href) => {
    expect(ALLOWED_URI_REGEXP.test(href)).toBe(true);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://leantech.ru'],
    ['vbscript', 'vbscript:msgbox(1)'],
  ])('отвергает схему %s', (_name, href) => {
    expect(ALLOWED_URI_REGEXP.test(href)).toBe(false);
  });
});
