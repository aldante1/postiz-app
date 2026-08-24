import type {
  Attribute,
  Element as Parse5Element,
  Node as Parse5Node,
  TextNode,
} from 'parse5';

export const attributeValue = (attrs: Attribute[], name: string): string => {
  const attr = attrs.find((item) => item.name === name);
  return attr?.value ?? '';
};

export const hasAttribute = (attrs: Attribute[], name: string): boolean =>
  attrs.some((item) => item.name === name);

export const hrefProtocol = (href: string): string | null => {
  try {
    const url = new URL(href);
    return trimTrailingColon(url.protocol).toLowerCase();
  } catch {
    const colonIndex = href.indexOf(':');
    if (colonIndex > 0) {
      return href.slice(0, colonIndex).toLowerCase();
    }

    return null;
  }
};

export const trimTrailingColon = (value: string): string => {
  if (value.endsWith(':')) {
    return value.slice(0, value.length - 1);
  }

  return value;
};

export const trimTrailingLineBreaks = (value: string): string => {
  let end = value.length;

  while (end > 0 && value.charAt(end - 1) === '\n') {
    end--;
  }

  return value.slice(0, end);
};

export const escapeText = (value: string): string =>
  value.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');

export const escapeAttribute = (value: string): string =>
  escapeText(value).split('"').join('&quot;');

export const isTextNode = (node: Parse5Node): node is TextNode =>
  node.nodeName === '#text';

export const isElementNode = (node: Parse5Node): node is Parse5Element =>
  'tagName' in node && 'childNodes' in node;
