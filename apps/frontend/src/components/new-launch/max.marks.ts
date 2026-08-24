import { Mark } from '@tiptap/core';
import Blockquote from '@tiptap/extension-blockquote';
import Code from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import Italic from '@tiptap/extension-italic';
import Strike from '@tiptap/extension-strike';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    maxHighlight: {
      setMaxHighlight: () => ReturnType;
      unsetMaxHighlight: () => ReturnType;
      toggleMaxHighlight: () => ReturnType;
    };
  }
}

export const MaxHighlight = Mark.create({
  name: 'maxHighlight',

  parseHTML() {
    return [{ tag: 'mark' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['mark', HTMLAttributes, 0];
  },

  addCommands() {
    return {
      setMaxHighlight:
        () =>
        ({ commands }) => {
          return commands.setMark(this.name);
        },
      unsetMaxHighlight:
        () =>
        ({ commands }) => {
          return commands.unsetMark(this.name);
        },
      toggleMaxHighlight:
        () =>
        ({ commands }) => {
          return commands.toggleMark(this.name);
        },
    };
  },
});

export const maxExtensions = () => [
  Italic,
  Strike,
  Code,
  CodeBlock,
  Blockquote,
  MaxHighlight,
];
