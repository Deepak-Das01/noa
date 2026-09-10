const FOLLOW_UP_PREFIX = /^(what about|how about|tell me more about|more about|and what about|explain)\b/i;
const INDEPENDENT_PREFIX = /^(who|when|where|why|which|ceo|president|founder)\b/i;

export function isIndependentQuery(query) {
  const text = String(query || '').trim();
  if (!text) return true;
  if (INDEPENDENT_PREFIX.test(text)) return true;
  if (/\b(ceo|red\s*hat|redhat|ibm|microsoft|google)\b/i.test(text) && !/\b(service|kubernetes|k8s|pod|cluster)\b/i.test(text)) {
    return true;
  }
  return false;
}

export function isLikelyFollowUp(current, previousUserMessage) {
  const currentText = String(current || '').trim();
  const previousText = String(previousUserMessage || '').trim();
  if (!currentText || !previousText) return false;
  if (isIndependentQuery(currentText)) return false;
  if (FOLLOW_UP_PREFIX.test(currentText)) return true;
  if (currentText.split(/\s+/).length <= 5 && /\b(nodeport|loadbalancer|clusterip|headless|externalname|that|those|it)\b/i.test(currentText)) {
    return true;
  }
  return false;
}

export function resolveRetrievalQuery(currentMessage, priorMessages = []) {
  const current = String(currentMessage || '').trim();
  if (!current) return current;

  const userMessages = priorMessages.filter(item => item.role === 'user').map(item => item.content);
  const previousUser = userMessages.at(-1);
  if (!previousUser || !isLikelyFollowUp(current, previousUser)) return current;

  if (FOLLOW_UP_PREFIX.test(current)) {
    return `${previousUser} ${current}`.replace(/\s+/g, ' ').trim();
  }

  if (/\b(nodeport|loadbalancer|clusterip|headless|externalname)\b/i.test(current) && !/\bservice/i.test(current)) {
    return `Kubernetes Service ${current}`;
  }

  return `${previousUser} ${current}`.replace(/\s+/g, ' ').trim();
}

export function buildConversationHistory(priorMessages, limit = 6) {
  return priorMessages
    .slice(-limit)
    .filter(item => item.role === 'user' || item.role === 'assistant')
    .map(item => ({
      role: item.role,
      content: String(item.content || '').trim(),
    }))
    .filter(item => item.content);
}
