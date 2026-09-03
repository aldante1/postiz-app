'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { createRichTextPreviewComponent } from '@gitroom/frontend/components/launches/rich.text.preview.component';
import { telegramVisibleLength } from '@gitroom/nestjs-libraries/integrations/social/telegram.html';
import { telegramLimit } from '@gitroom/helpers/utils/telegram.limits';
export default withProvider({
  postComment: PostComment.COMMENT,
  minimumCharacters: [],
  SettingsComponent: null,
  CustomPreviewComponent: createRichTextPreviewComponent(telegramVisibleLength),
  dto: undefined,
  maximumCharacters: (_settings: unknown, hasMedia: boolean) =>
    telegramLimit(hasMedia),
});
