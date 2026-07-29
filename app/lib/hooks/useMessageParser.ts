import type { Message } from 'ai';
import { useCallback, useState } from 'react';
import { EnhancedStreamingMessageParser } from '~/lib/runtime/enhanced-message-parser';
import { workbenchStore } from '~/lib/stores/workbench';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('useMessageParser');

const messageParser = new EnhancedStreamingMessageParser({
  callbacks: {
    onArtifactOpen: (data) => {
      logger.trace('onArtifactOpen', data);

      workbenchStore.showWorkbench.set(true);
      workbenchStore.addArtifact(data);
    },
    onArtifactClose: (data) => {
      logger.trace('onArtifactClose');

      workbenchStore.updateArtifact(data, { closed: true });
    },
    onActionOpen: (data) => {
      logger.trace('onActionOpen', data.action);

      /*
       * File actions are streamed, so we add them immediately to show progress.
       * Shell actions are complete when created by the enhanced parser, so we wait for close.
       */
      if (data.action.type === 'file') {
        workbenchStore.addAction(data);
      }
    },
    onActionClose: (data) => {
      logger.trace('onActionClose', data.action);

      /*
       * Add non-file actions (shell, build, start, etc.) when they close.
       * Enhanced parser creates complete shell actions, so they are ready to execute.
       */
      if (data.action.type !== 'file') {
        workbenchStore.addAction(data);
      }

      workbenchStore.runAction(data);
    },
    onActionStream: (data) => {
      logger.trace('onActionStream', data.action);
      workbenchStore.runAction(data, true);
    },
  },
});

const extractTextContent = (message: Message) =>
  Array.isArray(message.content)
    ? (message.content.find((item) => item.type === 'text')?.text as string) || ''
    : message.content;

/**
 * Providers can occasionally finish a response after streaming file content but
 * before emitting the closing bolt tags. Without a closing action callback the
 * workbench leaves that file in a permanent running state. Repair only the final
 * unmatched tags after streaming has ended; complete responses remain unchanged.
 */
function closeUnterminatedBoltTags(content: string): string {
  let repaired = content;
  const lastActionOpen = repaired.lastIndexOf('<boltAction');
  const lastActionClose = repaired.lastIndexOf('</boltAction>');

  if (lastActionOpen > lastActionClose) {
    const artifactCloseIndex = repaired.indexOf('</boltArtifact>', lastActionOpen);
    const closingAction = '\n</boltAction>\n';

    if (artifactCloseIndex >= 0) {
      repaired = `${repaired.slice(0, artifactCloseIndex)}${closingAction}${repaired.slice(artifactCloseIndex)}`;
    } else {
      repaired += closingAction;
    }

    logger.warn('Finalized an unterminated bolt action after the response stream ended');
  }

  const lastArtifactOpen = repaired.lastIndexOf('<boltArtifact');
  const lastArtifactClose = repaired.lastIndexOf('</boltArtifact>');

  if (lastArtifactOpen > lastArtifactClose) {
    repaired += '\n</boltArtifact>';
    logger.warn('Finalized an unterminated bolt artifact after the response stream ended');
  }

  return repaired;
}

export function useMessageParser() {
  const [parsedMessages, setParsedMessages] = useState<{ [key: number]: string }>({});

  const parseMessages = useCallback((messages: Message[], isLoading: boolean) => {
    let reset = false;

    if (import.meta.env.DEV && !isLoading) {
      reset = true;
      messageParser.reset();
    }

    for (const [index, message] of messages.entries()) {
      if (message.role === 'assistant' || message.role === 'user') {
        const rawContent = extractTextContent(message);
        const parseableContent = !isLoading && message.role === 'assistant' ? closeUnterminatedBoltTags(rawContent) : rawContent;
        const newParsedContent = messageParser.parse(message.id, parseableContent);

        setParsedMessages((prevParsed) => ({
          ...prevParsed,
          [index]: !reset ? (prevParsed[index] || '') + newParsedContent : newParsedContent,
        }));
      }
    }
  }, []);

  return { parsedMessages, parseMessages };
}
