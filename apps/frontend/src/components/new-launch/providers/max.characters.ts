// Лимит символов площадки. Отдельный модуль без React-графа: и редактор, и
// провайдеры, и тесты считают лимит одной функцией. Telegram зависит от медиа
// (4096 текст / 1024 caption), остальные площадки возвращают число.
export type MaximumCharacters =
  | number
  | ((settings: unknown, hasMedia: boolean) => number);

export const resolveMaxCharacters = (
  maximumCharacters: MaximumCharacters | undefined,
  settings: unknown,
  hasMedia: boolean
): number | undefined => {
  if (typeof maximumCharacters === 'undefined') {
    return undefined;
  }

  if (typeof maximumCharacters === 'number') {
    return maximumCharacters;
  }

  return maximumCharacters(settings, hasMedia);
};
