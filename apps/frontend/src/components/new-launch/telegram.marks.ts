import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import Blockquote from '@tiptap/extension-blockquote';
import Code from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import Italic from '@tiptap/extension-italic';
import Strike from '@tiptap/extension-strike';
// Interlock-расширения зовут команды bold/underline: их типы приходят из
// module augmentation этих пакетов, поэтому импорт нужен и в этом файле,
// иначе модуль компилируется только вместе с editor.tsx.
import '@tiptap/extension-bold';
import '@tiptap/extension-underline';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    telegramSpoiler: {
      setTelegramSpoiler: () => ReturnType;
      unsetTelegramSpoiler: () => ReturnType;
      toggleTelegramSpoiler: () => ReturnType;
    };
    telegramBlockquote: {
      toggleExpandableBlockquote: () => ReturnType;
    };
  }
}

export const InterceptBoldShortcut = Extension.create({
  name: 'preventBoldWithUnderline',

  addKeyboardShortcuts() {
    return {
      'Mod-b': () => {
        // For example, toggle bold while removing underline
        this?.editor?.commands?.unsetUnderline();
        return this?.editor?.commands?.toggleBold();
      },
    };
  },
});

export const InterceptUnderlineShortcut = Extension.create({
  name: 'preventUnderlineWithUnderline',

  addKeyboardShortcuts() {
    return {
      'Mod-u': () => {
        // For example, toggle bold while removing underline
        this?.editor?.commands?.unsetBold();
        return this?.editor?.commands?.toggleUnderline();
      },
    };
  },
});

export const TelegramSpoiler = Mark.create({
  name: 'telegramSpoiler',

  parseHTML() {
    return [{ tag: 'tg-spoiler' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['tg-spoiler', HTMLAttributes, 0];
  },

  addCommands() {
    return {
      setTelegramSpoiler:
        () =>
        ({ commands }) => {
          return commands.setMark(this.name);
        },
      unsetTelegramSpoiler:
        () =>
        ({ commands }) => {
          return commands.unsetMark(this.name);
        },
      toggleTelegramSpoiler:
        () =>
        ({ commands }) => {
          return commands.toggleMark(this.name);
        },
    };
  },
});

export const TelegramBlockquote = Blockquote.extend({
  addAttributes() {
    return {
      expandable: {
        default: false,
        parseHTML: (element) => element.hasAttribute('expandable'),
        renderHTML: (attributes) =>
          attributes.expandable ? { expandable: '' } : {},
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'blockquote',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      0,
    ];
  },

  addCommands() {
    return {
      ...this.parent?.(),
      toggleExpandableBlockquote:
        () =>
        ({ commands, editor }) => {
          const isExpandable = editor.isActive(this.name, { expandable: true });

          if (!editor.isActive(this.name)) {
            return commands.toggleWrap(this.name, { expandable: true });
          }

          return commands.updateAttributes(this.name, {
            expandable: !isExpandable,
          });
        },
    };
  },
});

export const telegramExtensions = () => [
  Italic,
  Strike,
  Code,
  CodeBlock,
  TelegramBlockquote,
  TelegramSpoiler,
];

export const interlockExtensions = () => [
  InterceptBoldShortcut,
  InterceptUnderlineShortcut,
];
