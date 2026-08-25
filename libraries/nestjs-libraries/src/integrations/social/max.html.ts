import { parseFragment } from 'parse5';
import type {
  ChildNode,
  Element as Parse5Element,
  Node as Parse5Node,
} from 'parse5';
import {
  attributeValue,
  escapeAttribute,
  escapeText,
  hrefProtocol,
  isElementNode,
  isTextNode,
  trimTrailingLineBreaks,
} from './rich.html';

export type MaxHtml = { html: string; length: number };

export class MaxFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaxFormatError';
  }
}

type ListType = 'ul' | 'ol';

type ListState = {
  type: ListType;
  depth: number;
  nextIndex: number;
};

type FormatterState = {
  insideCode: boolean;
  insidePre: boolean;
  throwOnInvalid: boolean;
  lists: ListState[];
};

type OutputToken =
  | { type: 'raw'; html: string }
  | { type: 'text'; value: string };

const allowedProtocols = ['http', 'https', 'mailto', 'tel'];
const maxUserHrefPattern = /^max:\/\/user\/\d+$/;
const maxHrefLength = 2048;

class MaxHtmlWriter {
  private readonly tokens: OutputToken[] = [];
  private lastVisibleCharacter = '';
  private hasVisibleCharacters = false;

  raw(html: string) {
    this.tokens.push({ type: 'raw', html });
  }

  text(value: string) {
    if (value.length === 0) {
      return;
    }

    for (const character of value) {
      this.lastVisibleCharacter = character;
    }

    this.hasVisibleCharacters = true;
    this.tokens.push({ type: 'text', value });
  }

  lineBreak() {
    this.text('\n');
  }

  // Перевод строки, который нужен только как разделитель блоков: если предыдущий
  // блок уже закончился переводом строки (типичный `<li><p>…</p></li>` из tiptap),
  // второй не нужен. Абзацы этим не пользуются — там пустой `<p>` намеренно даёт
  // пустую строку, и её нельзя схлопывать.
  blockBreak() {
    if (this.hasVisibleCharacters && this.lastVisibleCharacter !== '\n') {
      this.lineBreak();
    }
  }

  // Позиция для последующей обрезки: всё, что запишут после неё, принадлежит
  // открытому блоку.
  mark(): number {
    return this.tokens.length;
  }

  // Хвостовой перевод строки от внутреннего `<p>` обязан оказаться ЗА закрывающим
  // тегом блока, иначе MAX растянет цитату или блок кода на лишнюю пустую строку.
  trimTrailingLineBreaksSince(mark: number) {
    this.trimTokens(mark);
    this.recalculateLastVisibleCharacter();
  }

  private trimTokens(from: number) {
    for (let index = this.tokens.length - 1; index >= from; index--) {
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

  private recalculateLastVisibleCharacter() {
    for (let index = this.tokens.length - 1; index >= 0; index--) {
      const token = this.tokens[index];

      if (token.type === 'text' && token.value.length > 0) {
        this.lastVisibleCharacter = token.value[token.value.length - 1];
        return;
      }
    }

    this.lastVisibleCharacter = '';
  }

  toMaxHtml(): MaxHtml {
    this.trimTokens(0);

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

export const toMaxHtml = (editorHtml: string): MaxHtml =>
  formatMaxHtml(editorHtml, true);

export const maxVisibleLength = (editorHtml: string): number => {
  try {
    return toMaxHtml(editorHtml).length;
  } catch (error: unknown) {
    if (error instanceof MaxFormatError) {
      return formatMaxHtml(editorHtml, false).length;
    }

    throw error;
  }
};

const formatMaxHtml = (editorHtml: string, throwOnInvalid: boolean): MaxHtml => {
  const fragment = parseFragment(editorHtml);
  const writer = new MaxHtmlWriter();

  formatChildren(fragment.childNodes, writer, {
    insideCode: false,
    insidePre: false,
    throwOnInvalid,
    lists: [],
  });

  return writer.toMaxHtml();
};

const formatChildren = (
  children: ChildNode[],
  writer: MaxHtmlWriter,
  state: FormatterState
) => {
  for (const child of children) {
    formatNode(child, writer, state);
  }
};

const formatNode = (
  node: Parse5Node,
  writer: MaxHtmlWriter,
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
  writer: MaxHtmlWriter,
  state: FormatterState
) => {
  const tagName = normalizeTagName(node.tagName);

  if (tagName === 'br') {
    writer.lineBreak();
    return;
  }

  if (tagName === 'a') {
    formatLink(node, writer, state);
    return;
  }

  if (tagName === 'ul' || tagName === 'ol') {
    formatList(tagName, node, writer, state);
    return;
  }

  if (tagName === 'li') {
    formatListItem(node, writer, state);
    return;
  }

  if (isAllowedMaxTag(tagName)) {
    formatAllowedElement(tagName, node, writer, state);
    return;
  }

  formatChildren(node.childNodes, writer, state);

  // `p`/`div` дают перевод строки всегда: пустой абзац — это намеренная пустая
  // строка. `blockquote` — обёртка над абзацами, её собственный перевод строки
  // нужен только если содержимое им не закончилось.
  if (tagName === 'blockquote') {
    writer.blockBreak();
    return;
  }

  if (isUnknownBlockTag(tagName)) {
    writer.lineBreak();
  }
};

const formatLink = (
  node: Parse5Element,
  writer: MaxHtmlWriter,
  state: FormatterState
) => {
  const href = attributeValue(node.attrs, 'href').trim();

  if (href.length === 0) {
    formatChildren(node.childNodes, writer, state);
    return;
  }

  if (href.length > maxHrefLength) {
    if (state.throwOnInvalid) {
      throw new MaxFormatError('MAX link URL exceeds 2048 characters.');
    }

    formatChildren(node.childNodes, writer, state);
    return;
  }

  const protocol = hrefProtocol(href);
  const allowed =
    (protocol !== null && allowedProtocols.includes(protocol)) ||
    maxUserHrefPattern.test(href);

  if (!allowed) {
    if (state.throwOnInvalid) {
      throw new MaxFormatError(
        `Unsupported MAX link protocol: ${protocol ?? 'missing'}`
      );
    }

    formatChildren(node.childNodes, writer, state);
    return;
  }

  writer.raw(`<a href="${escapeAttribute(href)}">`);
  formatChildren(node.childNodes, writer, state);
  writer.raw('</a>');
};

const formatList = (
  tagName: ListType,
  node: Parse5Element,
  writer: MaxHtmlWriter,
  state: FormatterState
) => {
  writer.blockBreak();
  const list: ListState = {
    type: tagName,
    depth: state.lists.length,
    nextIndex: 1,
  };

  formatChildren(node.childNodes, writer, {
    ...state,
    lists: [...state.lists, list],
  });
};

const formatListItem = (
  node: Parse5Element,
  writer: MaxHtmlWriter,
  state: FormatterState
) => {
  const currentList = state.lists[state.lists.length - 1];

  if (!currentList) {
    formatChildren(node.childNodes, writer, state);
    writer.blockBreak();
    return;
  }

  writer.blockBreak();

  const marker =
    currentList.type === 'ul' ? '• ' : `${currentList.nextIndex++}. `;
  writer.text(`${'  '.repeat(currentList.depth)}${marker}`);
  formatChildren(node.childNodes, writer, state);
  writer.blockBreak();
};

const formatAllowedElement = (
  tagName: string,
  node: Parse5Element,
  writer: MaxHtmlWriter,
  state: FormatterState
) => {
  if (tagName === 'pre' && (state.insidePre || state.insideCode)) {
    handleInvalidNesting('pre', state.insideCode ? 'code' : 'pre', state, node, writer);
    return;
  }

  if (tagName === 'code' && state.insideCode) {
    handleInvalidNesting('code', 'code', state, node, writer);
    return;
  }

  const isBlock = tagName === 'h1' || tagName === 'pre';

  writer.raw(`<${tagName}>`);
  const contentStart = writer.mark();
  formatChildren(node.childNodes, writer, {
    ...state,
    insideCode: tagName === 'code' ? true : state.insideCode,
    insidePre: tagName === 'pre' ? true : state.insidePre,
  });

  if (isBlock) {
    writer.trimTrailingLineBreaksSince(contentStart);
  }

  writer.raw(`</${tagName}>`);

  if (isBlock) {
    writer.blockBreak();
  }
};

const handleInvalidNesting = (
  tagName: 'code' | 'pre',
  parentTagName: 'code' | 'pre',
  state: FormatterState,
  node: Parse5Element,
  writer: MaxHtmlWriter
) => {
  if (state.throwOnInvalid) {
    throw new MaxFormatError(
      `Invalid MAX HTML nesting: ${tagName} inside ${parentTagName}`
    );
  }

  formatChildren(node.childNodes, writer, state);
};

const normalizeTagName = (tagName: string): string => {
  switch (tagName) {
    case 'strong':
      return 'b';
    case 'em':
      return 'i';
    case 'ins':
      return 'u';
    case 'strike':
    case 'del':
      return 's';
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'h1';
    default:
      return tagName;
  }
};

// `blockquote` здесь нет намеренно: схема MAX объявляет QuoteMarkup, но живой API
// 25.08 не создал сущность ни на `<blockquote>`, ни на markdown `> ` — тег просто
// вырезается. Отправлять его бессмысленно, содержимое выводим отдельным блоком.
const isAllowedMaxTag = (tagName: string): boolean => {
  switch (tagName) {
    case 'b':
    case 'i':
    case 'u':
    case 's':
    case 'code':
    case 'pre':
    case 'mark':
    case 'h1':
      return true;
    default:
      return false;
  }
};

const isUnknownBlockTag = (tagName: string): boolean => {
  switch (tagName) {
    case 'p':
    case 'div':
      return true;
    default:
      return false;
  }
};
