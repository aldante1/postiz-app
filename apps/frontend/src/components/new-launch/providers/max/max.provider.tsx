'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { createRichTextPreviewComponent } from '@gitroom/frontend/components/launches/rich.text.preview.component';
import { maxVisibleLength } from '@gitroom/nestjs-libraries/integrations/social/max.html';

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: null,
  CustomPreviewComponent: createRichTextPreviewComponent(maxVisibleLength),
  dto: undefined,
  maximumCharacters: 4000,
});
