// Ворота между редактором и базой: всё, чего здесь нет, DOMPurify вырезает в DTO
// создания поста — ДО провайдеров. Именно поэтому тулбар Telegram и MAX рисовал
// курсив, код и цитату, а в канал уходил плоский текст.
//
// Набор = объединение того, что умеют Telegram и MAX; лишние теги для остальных
// провайдеров всё равно снимает stripHtmlValidation в общем пайплайне.
//
// Файл отдельный и без зависимостей намеренно: `isomorphic-dompurify` тянет
// ESM-копии jsdom и parse5, из-за которых модуль нельзя импортировать в jest.
export const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'u',
  'ins',
  'em',
  'i',
  's',
  'del',
  'strike',
  'code',
  'pre',
  'mark',
  'blockquote',
  'tg-spoiler',
  'a',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'span',
];

export const ALLOWED_ATTR = [
  'href',
  'target',
  'rel',
  'class',
  // Сворачиваемая цитата Telegram: `<blockquote expandable>`.
  'expandable',
  'data-mention-id',
  'data-mention-label',
];

// `tel:` нужен Telegram и MAX, `tg:` — внутренним ссылкам Telegram, `max:` —
// упоминаниям `max://user/<id>`. Схему валидирует ещё и formatter провайдера,
// здесь только пропускаем её дальше.
export const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|tel:|tg:|max:|\/|#)/i;
