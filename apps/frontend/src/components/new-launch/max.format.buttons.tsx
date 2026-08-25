'use client';

import type { Editor } from '@tiptap/core';
import type { FC } from 'react';
import { FormatButton } from '@gitroom/frontend/components/new-launch/format.button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

export const MaxFormatButtons: FC<{ editor: Editor | null | undefined }> = ({
  editor,
}) => {
  const t = useT();

  return (
    <div className="flex gap-[5px]">
      <FormatButton
        tooltip={t('format_italic', 'Italic')}
        active={Boolean(editor?.isActive?.('italic'))}
        onClick={() => {
          editor?.commands?.toggleItalic();
          editor?.commands?.focus();
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M9.33398 2.66699H12.0007M4.00065 13.3337H6.66732M10.6673 2.66699L5.33398 13.3337"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </FormatButton>
      <FormatButton
        tooltip={t('format_strikethrough', 'Strikethrough')}
        active={Boolean(editor?.isActive?.('strike'))}
        onClick={() => {
          editor?.commands?.toggleStrike();
          editor?.commands?.focus();
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M4.66602 4.33366C4.66602 3.41299 6.00735 2.66699 7.66602 2.66699C9.32468 2.66699 10.666 3.41299 10.666 4.33366M3.33398 8.00033H12.6673M10.6673 11.667C10.6673 12.5877 9.32598 13.3337 7.66732 13.3337C6.00865 13.3337 4.66732 12.5877 4.66732 11.667"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </FormatButton>
      <FormatButton
        tooltip={t('format_inline_code', 'Inline code')}
        active={Boolean(editor?.isActive?.('code'))}
        onClick={() => {
          editor?.commands?.toggleCode();
          editor?.commands?.focus();
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M5.33333 5.33301L2.66667 7.99967L5.33333 10.6663M10.6667 5.33301L13.3333 7.99967L10.6667 10.6663M9 3.33301L7 12.6663"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </FormatButton>
      <FormatButton
        tooltip={t('format_code_block', 'Code block')}
        active={Boolean(editor?.isActive?.('codeBlock'))}
        onClick={() => {
          editor?.commands?.toggleCodeBlock();
          editor?.commands?.focus();
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M2.66667 4.66634C2.66667 3.92996 3.26362 3.33301 4 3.33301H12C12.7364 3.33301 13.3333 3.92996 13.3333 4.66634V11.333C13.3333 12.0694 12.7364 12.6663 12 12.6663H4C3.26362 12.6663 2.66667 12.0694 2.66667 11.333V4.66634ZM5.33333 6.66634L4.33333 7.99967L5.33333 9.33301M10.6667 6.66634L11.6667 7.99967L10.6667 9.33301M8.66667 6.33301L7.33333 9.66634"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </FormatButton>
      <FormatButton
        tooltip={t('format_highlight', 'Highlight')}
        active={Boolean(editor?.isActive?.('maxHighlight'))}
        onClick={() => {
          editor?.commands?.toggleMaxHighlight();
          editor?.commands?.focus();
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M10.6673 2.66699L13.334 5.33366L6.00065 12.667H3.33398V10.0003L10.6673 2.66699ZM9.33398 4.00033L12.0007 6.66699M3.33398 13.3337H12.6673"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </FormatButton>
    </div>
  );
};
