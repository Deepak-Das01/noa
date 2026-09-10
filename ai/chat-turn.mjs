import {
  buildConversationMessages,
  buildDocumentsOnlySystemPromptWithMetadata,
  buildDocumentsPlusModelSystemPrompt,
  buildGroundedUserPrompt,
  buildModelOnlyUserPrompt,
  resolveGroundingMode,
  sanitizeCitations,
} from './prompt.mjs';
import { buildConversationHistory, resolveRetrievalQuery } from './query.mjs';
import { hasRelevantSources } from '../retrieval/relevance.mjs';
import {
  isFreshnessSensitive,
  evaluateSourceFreshness,
  resolveGroundingBadge,
  shouldUseDeterministicUnverifiedResponse,
  buildUnverifiedFreshnessResponse,
  buildSystemMetadataBlock,
} from './freshness.mjs';

export function prepareTurnContext({
  currentQuestion,
  priorMessages,
  answerMode,
  relevantSources,
  temporaryContext,
}) {
  const hasRelevant = hasRelevantSources(relevantSources);
  const groundingMode = resolveGroundingMode(answerMode, hasRelevant);
  const freshnessSensitive = isFreshnessSensitive(currentQuestion);
  const history = buildConversationHistory(priorMessages, 6);
  const contextSources = hasRelevant
    ? relevantSources.map((source, index) => ({ ...source, sourceId: `S${index + 1}` }))
    : [];

  const sourceFreshness = evaluateSourceFreshness(contextSources, { freshnessSensitive });
  const grounding = resolveGroundingBadge({
    groundingMode,
    freshnessSensitive,
    possiblyStale: sourceFreshness.possiblyStale,
  });

  const systemMetadata = buildSystemMetadataBlock({
    groundingMode,
    freshnessSensitive,
    possiblyStale: sourceFreshness.possiblyStale,
    recentSupportingSources: contextSources.length ? 'yes' : 'none',
  });

  const skipLlm = shouldUseDeterministicUnverifiedResponse({ groundingMode, freshnessSensitive });
  const deterministicResponse = skipLlm ? buildUnverifiedFreshnessResponse() : null;

  let systemPrompt;
  let userPrompt;

  if (answerMode === 'documents_only') {
    systemPrompt = buildDocumentsOnlySystemPromptWithMetadata({
      systemMetadata,
      possiblyStale: sourceFreshness.possiblyStale,
    });
    userPrompt = hasRelevant
      ? buildGroundedUserPrompt({ currentQuestion, sources: contextSources, temporaryContext })
      : buildModelOnlyUserPrompt({ currentQuestion, temporaryContext });
  } else if (groundingMode === 'model-only') {
    systemPrompt = buildDocumentsPlusModelSystemPrompt({
      hasDocumentSources: false,
      freshnessSensitive,
      systemMetadata,
    });
    userPrompt = buildModelOnlyUserPrompt({ currentQuestion, temporaryContext });
  } else {
    systemPrompt = buildDocumentsPlusModelSystemPrompt({
      hasDocumentSources: true,
      freshnessSensitive,
      systemMetadata,
    });
    userPrompt = buildGroundedUserPrompt({ currentQuestion, sources: contextSources, temporaryContext });
  }

  const messages = skipLlm ? [] : buildConversationMessages({ systemPrompt, history, userPrompt });

  return {
    groundingMode,
    groundingBadge: grounding.badge,
    groundingLabel: grounding.label,
    freshnessSensitive,
    possiblyStale: sourceFreshness.possiblyStale,
    freshnessWarning: grounding.freshnessWarning || false,
    skipLlm,
    deterministicResponse,
    hasRelevant,
    contextSources,
    messages,
    usedSourceIds: contextSources.map(source => source.sourceId),
    retrievalCount: relevantSources.length,
  };
}

export function resolveRetrievalInput(currentQuestion, priorMessages) {
  const retrievalQuery = resolveRetrievalQuery(currentQuestion, priorMessages);
  return { currentQuestion, retrievalQuery };
}

export function insufficientDocumentsMessage() {
  return "I couldn't find enough information in the selected knowledge base to answer this confidently.";
}

export function finalizeAssistantText(text, usedSourceIds) {
  return sanitizeCitations(text, usedSourceIds);
}
