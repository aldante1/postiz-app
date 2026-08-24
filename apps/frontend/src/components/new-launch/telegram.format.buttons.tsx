'use client';

import clsx from 'clsx';
import { FC, ReactNode } from 'react';

const baseButtonClass =
  'select-none cursor-pointer rounded-[6px] w-[30px] h-[30px] bg-newColColor flex justify-center items-center';

type TelegramFormatButtonProps = {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
  tooltip: string;
};

const TelegramFormatButton: FC<TelegramFormatButtonProps> = ({
  active,
  children,
  onClick,
  tooltip,
}) => {
  return (
    <div
      data-tooltip-id="tooltip"
      data-tooltip-content={tooltip}
      onClick={onClick}
      className={clsx(baseButtonClass, active && 'ring-1 ring-white/40 text-white')}
    >
      {children}
    </div>
  );
};

export const TelegramFormatButtons: FC<{ editor: any }> = ({ editor }) => {
  const expandableBlockquoteActive = Boolean(
    editor?.isActive?.('blockquote', { expandable: true })
  );

  return (
    <div className="flex gap-[5px]">
      <TelegramFormatButton
        tooltip="Italic"
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
      </TelegramFormatButton>
      <TelegramFormatButton
        tooltip="Strikethrough"
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
      </TelegramFormatButton>
      <TelegramFormatButton
        tooltip="Inline code"
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
      </TelegramFormatButton>
      <TelegramFormatButton
        tooltip="Code block"
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
      </TelegramFormatButton>
      <TelegramFormatButton
        tooltip="Quote"
        active={Boolean(editor?.isActive?.('blockquote'))}
        onClick={() => {
          editor?.commands?.toggleBlockquote();
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
            d="M6.00065 4.66699H4.66732C3.93094 4.66699 3.33398 5.26395 3.33398 6.00033V7.33366C3.33398 8.07004 3.93094 8.66699 4.66732 8.66699H5.33398V11.3337M12.0007 4.66699H10.6673C9.93094 4.66699 9.33398 5.26395 9.33398 6.00033V7.33366C9.33398 8.07004 9.93094 8.66699 10.6673 8.66699H11.334V11.3337"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </TelegramFormatButton>
      <TelegramFormatButton
        tooltip="Expandable quote"
        active={expandableBlockquoteActive}
        onClick={() => {
          editor?.commands?.toggleExpandableBlockquote();
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
            d="M5.33398 4.66699H4.66732C3.93094 4.66699 3.33398 5.26395 3.33398 6.00033V7.33366C3.33398 8.07004 3.93094 8.66699 4.66732 8.66699H5.33398V11.3337M10.6673 4.66699H10.0007C9.26427 4.66699 8.66732 5.26395 8.66732 6.00033V7.33366C8.66732 8.07004 9.26427 8.66699 10.0007 8.66699H10.6673V11.3337M12.6673 5.33366L14.0007 6.66699L12.6673 8.00033M14.0007 9.33366L12.6673 10.667L14.0007 12.0003"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </TelegramFormatButton>
      <TelegramFormatButton
        tooltip="Spoiler"
        active={Boolean(editor?.isActive?.('telegramSpoiler'))}
        onClick={() => {
          editor?.commands?.toggleTelegramSpoiler();
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
            d="M2.66602 8.00033C3.66602 5.66699 5.44379 4.66699 7.99935 4.66699C10.555 4.66699 12.3327 5.66699 13.3327 8.00033C12.3327 10.3337 10.555 11.3337 7.99935 11.3337C5.44379 11.3337 3.66602 10.3337 2.66602 8.00033ZM7.99935 6.66699C7.26297 6.66699 6.66602 7.26395 6.66602 8.00033C6.66602 8.73671 7.26297 9.33366 7.99935 9.33366C8.73573 9.33366 9.33268 8.73671 9.33268 8.00033C9.33268 7.26395 8.73573 6.66699 7.99935 6.66699ZM3.33398 12.667L12.6673 3.33366"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </TelegramFormatButton>
    </div>
  );
};
