import { parseFragment } from 'parse5';
import type {
  Attribute,
  ChildNode,
  Element as Parse5Element,
  Node as Parse5Node,
} from 'parse5';
import {
  attributeValue,
  escapeAttribute,
  escapeText,
  hasAttribute,
  hrefProtocol,
  isElementNode,
  isTextNode,
  trimTrailingLineBreaks,
} from './rich.html';

export type TelegramHtml = { html: string; length: number };

export class TelegramFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramFormatError';
  }
}

type FormatterState = {
  insideCode: boolean;
  insidePre: boolean;
  throwOnInvalid: boolean;
};

type OutputToken =
  | { type: 'raw'; html: string }
  | { type: 'text'; value: string };

const allowedProtocols = ['http', 'https', 'tg', 'mailto'];

class TelegramHtmlWriter {
  private readonly tokens: OutputToken[] = [];

  raw(html: string) {
    this.tokens.push({ type: 'raw', html });
  }

  text(value: string) {
    if (value.length === 0) {
      return;
    }

    this.tokens.push({ type: 'text', value });
  }

  trimTrailingLineBreaks() {
    for (let index = this.tokens.length - 1; index >= 0; index--) {
      const token = this.tokens[index];

      if (token.type === 'raw') {
        continue;
      }

      const trimmed = trimTrailingLineBreaks(token.value);
      if (trimmed.length === 0) {
        this.tokens.splice(index, 1);
        continue;
      }

      if (trimmed.length !== token.value.length) {
        this.tokens[index] = { type: 'text', value: trimmed };
      }

      return;
    }
  }

  toTelegramHtml(): TelegramHtml {
    this.trimTrailingLineBreaks();

    let html = '';
    let text = '';

    for (const token of this.tokens) {
      if (token.type === 'raw') {
        html += token.html;
        continue;
      }

      html += escapeText(token.value);
      text += token.value;
    }

    return { html, length: text.length };
  }
}

export const toTelegramHtml = (editorHtml: string): TelegramHtml =>
  formatTelegramHtml(editorHtml, true);

export const telegramVisibleLength = (editorHtml: string): number => {
  try {
    return toTelegramHtml(editorHtml).length;
  } catch (error: unknown) {
    if (error instanceof TelegramFormatError) {
      return formatTelegramHtml(editorHtml, false).length;
    }

    throw error;
  }
};

const formatTelegramHtml = (
  editorHtml: string,
  throwOnInvalid: boolean
): TelegramHtml => {
  const fragment = parseFragment(editorHtml);
  const writer = new TelegramHtmlWriter();

  formatChildren(fragment.childNodes, writer, {
    insideCode: false,
    insidePre: false,
    throwOnInvalid,
  });

  return writer.toTelegramHtml();
};

const formatChildren = (
  children: ChildNode[],
  writer: TelegramHtmlWriter,
  state: FormatterState
) => {
  for (const child of children) {
    formatNode(child, writer, state);
  }
};

const formatNode = (
  node: Parse5Node,
  writer: TelegramHtmlWriter,
  state: FormatterState
) => {
  if (isTextNode(node)) {
    writer.text(node.value);
    return;
  }

  if (!isElementNode(node)) {
    return;
  }

  formatElement(node, writer, state);
};

const formatElement = (
  node: Parse5Element,
  writer: TelegramHtmlWriter,
  state: FormatterState
) => {
  const tagName = normalizeTagName(node.tagName);

  if (tagName === 'br') {
    writer.text('\n');
    return;
  }

  if (tagName === 'a') {
    formatLink(node, writer, state);
    return;
  }

  if (isAllowedTelegramTag(tagName)) {
    formatAllowedElement(tagName, node, writer, state);
    return;
  }

  formatChildren(node.childNodes, writer, state);

  if (isUnknownBlockTag(tagName)) {
    writer.text('\n');
  }
};

const formatLink = (
  node: Parse5Element,
  writer: TelegramHtmlWriter,
  state: FormatterState
) => {
  const href = attributeValue(node.attrs, 'href').trim();

  if (href.length === 0) {
    formatChildren(node.childNodes, writer, state);
    return;
  }

  const protocol = hrefProtocol(href);
  if (protocol === null || !allowedProtocols.includes(protocol)) {
    if (state.throwOnInvalid) {
      throw new TelegramFormatError(
        `Unsupported Telegram link protocol: ${protocol ?? 'missing'}`
      );
    }

    formatChildren(node.childNodes, writer, state);
    return;
  }

  writer.raw(`<a href="${escapeAttribute(href)}">`);
  formatChildren(node.childNodes, writer, state);
  writer.raw('</a>');
};

const formatAllowedElement = (
  tagName: string,
  node: Parse5Element,
  writer: TelegramHtmlWriter,
  state: FormatterState
) => {
  if (tagName === 'pre' && (state.insidePre || state.insideCode)) {
    handleInvalidNesting('pre', state, node, writer);
    return;
  }

  if (tagName === 'code' && state.insideCode) {
    handleInvalidNesting('code', state, node, writer);
    return;
  }

  writer.raw(openTag(tagName, node.attrs));
  formatChildren(node.childNodes, writer, {
    ...state,
    insideCode: tagName === 'code' ? true : state.insideCode,
    insidePre: tagName === 'pre' ? true : state.insidePre,
  });
  writer.raw(`</${tagName}>`);
};

const handleInvalidNesting = (
  tagName: 'code' | 'pre',
  state: FormatterState,
  node: Parse5Element,
  writer: TelegramHtmlWriter
) => {
  if (state.throwOnInvalid) {
    throw new TelegramFormatError(
      `Invalid Telegram HTML nesting: ${tagName} inside ${tagName}`
    );
  }

  formatChildren(node.childNodes, writer, state);
};

const openTag = (tagName: string, attrs: Attribute[]): string => {
  if (tagName === 'blockquote' && hasAttribute(attrs, 'expandable')) {
    return '<blockquote expandable>';
  }

  return `<${tagName}>`;
};

const normalizeTagName = (tagName: string): string => {
  switch (tagName) {
    case 'strong':
      return 'b';
    case 'em':
      return 'i';
    case 'strike':
    case 'del':
      return 's';
    default:
      return tagName;
  }
};

const isAllowedTelegramTag = (tagName: string): boolean => {
  switch (tagName) {
    case 'b':
    case 'i':
    case 'u':
    case 's':
    case 'code':
    case 'pre':
    case 'blockquote':
    case 'tg-spoiler':
      return true;
    default:
      return false;
  }
};

const isUnknownBlockTag = (tagName: string): boolean => {
  switch (tagName) {
    case 'p':
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
    case 'div':
    case 'ul':
    case 'ol':
    case 'li':
      return true;
    default:
      return false;
  }
};

