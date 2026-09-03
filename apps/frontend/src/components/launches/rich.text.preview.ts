import { parseFragment, serialize } from 'parse5';

type PreviewNode = {
  childNodes?: PreviewNode[];
  nodeName: string;
  value?: string;
};

export type RichPreviewContent = {
  content: string;
  overflowHtml: string;
};

const textContent = (node: PreviewNode): string => {
  if (node.nodeName === '#text') {
    return node.value || '';
  }

  return (node.childNodes || []).map(textContent).join('');
};

const truncateChildNodes = (
  childNodes: PreviewNode[],
  remainingCharacters: number
): number => {
  let remaining = remainingCharacters;

  for (let index = 0; index < childNodes.length; index += 1) {
    const node = childNodes[index];

    if (node.nodeName === '#text') {
      const value = node.value || '';

      if (value.length > remaining) {
        node.value = value.slice(0, remaining);
        childNodes.splice(index + 1);
        return 0;
      }

      remaining -= value.length;
    } else if (node.childNodes) {
      remaining = truncateChildNodes(node.childNodes, remaining);
    }

    if (remaining === 0) {
      childNodes.splice(index + 1);
      return 0;
    }
  }

  return remaining;
};

export const prepareRichPreviewHtml = (
  sanitizedContent: string,
  maximumCharacters: number,
  formattedVisibleLength?: (content: string) => number
): RichPreviewContent => {
  const fullFragment = parseFragment(sanitizedContent) as unknown as PreviewNode;
  const visibleText = textContent(fullFragment);
  const formattingOverhead = formattedVisibleLength
    ? Math.max(0, formattedVisibleLength(sanitizedContent) - visibleText.length)
    : 0;
  const fragment = parseFragment(sanitizedContent) as unknown as PreviewNode;
  const childNodes = fragment.childNodes || [];
  const visibleLimit = Math.max(0, maximumCharacters - formattingOverhead);

  truncateChildNodes(childNodes, visibleLimit);

  return {
    content: serialize(fragment as never),
    overflowHtml: visibleText
      .slice(visibleLimit)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;'),
  };
};
