'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { RichTextPreviewComponent } from '@gitroom/frontend/components/launches/rich.text.preview.component';

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: null,
  CustomPreviewComponent: RichTextPreviewComponent,
  dto: undefined,
  maximumCharacters: 4000,
});
