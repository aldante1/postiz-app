import { parseFragment, serialize } from 'parse5';

type PreviewNode = {
  childNodes?: PreviewNode[];
  nodeName: string;
  value?: string;
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
  maximumCharacters: number
): string => {
  const fragment = parseFragment(sanitizedContent) as unknown as PreviewNode;
  const childNodes = fragment.childNodes || [];

  truncateChildNodes(childNodes, Math.max(0, maximumCharacters));

  return serialize(fragment as never);
};
