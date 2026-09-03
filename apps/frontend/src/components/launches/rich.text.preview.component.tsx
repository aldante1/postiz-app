import { GeneralPreviewComponent } from '@gitroom/frontend/components/launches/general.preview.component';
import { sanitizePostContent } from '@gitroom/helpers/utils/sanitize.post.content';
import { FC } from 'react';
import { prepareRichPreviewHtml } from '@gitroom/frontend/components/launches/rich.text.preview';

export const RichTextPreviewComponent: FC<{
  maximumCharacters?: number;
}> = (props) => (
  <GeneralPreviewComponent
    {...props}
    transformContent={(content, maximumCharacters) =>
      prepareRichPreviewHtml(sanitizePostContent(content), maximumCharacters)
    }
    previewClassName="[&_a]:text-blue-400 [&_a]:underline [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-customColor20 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:whitespace-pre-wrap"
  />
);
