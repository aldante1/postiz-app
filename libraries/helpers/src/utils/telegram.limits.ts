export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;

export const telegramLimit = (hasMedia: boolean): number =>
  hasMedia ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT;
