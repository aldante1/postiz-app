// Лимит символов площадки. Отдельный модуль без React-графа: и редактор, и
// провайдеры, и тесты считают лимит одной функцией. Telegram зависит от медиа
// (4096 текст / 1024 caption), остальные площадки возвращают число.
export type MaximumCharacters =
  | number
  | ((settings: unknown, hasMedia: boolean) => number);

// Лимит считается для каждого сообщения треда по его собственным вложениям:
// у Telegram альбом с подписью держит 1024, а второе сообщение без медиа
// (промпт под альбомом) — 4096. Поэтому провайдер отдаёт обе цифры сразу,
// а конкретный редактор выбирает свою через `pickCharLimit`.
export type CharLimits = { text: number; media: number };

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

export const resolveCharLimits = (
  maximumCharacters: MaximumCharacters | undefined,
  settings: unknown
): CharLimits | undefined => {
  if (typeof maximumCharacters === 'undefined') {
    return undefined;
  }

  if (typeof maximumCharacters === 'number') {
    return { text: maximumCharacters, media: maximumCharacters };
  }

  return {
    text: maximumCharacters(settings, false),
    media: maximumCharacters(settings, true),
  };
};

export const pickCharLimit = (
  limits: CharLimits | undefined,
  hasMedia: boolean
): number => (hasMedia ? limits?.media : limits?.text) || 0;
