'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { telegramLimit } from '@gitroom/helpers/utils/telegram.limits';
export default withProvider({
  postComment: PostComment.COMMENT,
  minimumCharacters: [],
  SettingsComponent: null,
  CustomPreviewComponent: undefined,
  dto: undefined,
  maximumCharacters: (_settings: unknown, hasMedia: boolean) =>
    telegramLimit(hasMedia),
});
