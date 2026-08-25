import DOMPurify from 'isomorphic-dompurify';
import {
  ALLOWED_ATTR,
  ALLOWED_TAGS,
  ALLOWED_URI_REGEXP,
} from '@gitroom/helpers/utils/sanitize.post.allowlist';

export const sanitizePostContent = (value: unknown): string => {
  if (typeof value !== 'string' || !value) {
    return '';
  }

  return DOMPurify.sanitize(value, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
  });
};
