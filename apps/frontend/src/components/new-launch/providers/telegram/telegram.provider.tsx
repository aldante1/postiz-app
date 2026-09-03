'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { RichTextPreviewComponent } from '@gitroom/frontend/components/launches/rich.text.preview.component';
import { telegramLimit } from '@gitroom/helpers/utils/telegram.limits';
export default withProvider({
  postComment: PostComment.COMMENT,
  minimumCharacters: [],
  SettingsComponent: null,
  CustomPreviewComponent: RichTextPreviewComponent,
  dto: undefined,
  maximumCharacters: (_settings: unknown, hasMedia: boolean) =>
    telegramLimit(hasMedia),
});
