/**
 * JARVIT Router Plugin for OpenClaw
 *
 * Semantic intent routing (no LLM call, ~5ms):
 * - Kimi K2.5: All tasks (general, coding, creative, research)
 * - Claude Sonnet: Complex debugging, architecture (escalation only)
 *
 * Escalation: After 2 consecutive failures, escalates to Claude
 */

// =============================================================================
// Types
// =============================================================================

interface Route {
  name: string;
  model: 'kimi' | 'minimax' | 'claude';
  utterances: string[];
  threshold: number;
}

interface RoutingResult {
  route: string;
  model: 'kimi' | 'minimax' | 'claude';
  confidence: number;
  escalated: boolean;
}

interface OpenClawRequest {
  userId: string;
  channelId: string;
  message: {
    content: string;
    role: 'user' | 'assistant' | 'system';
  };
  context?: {
    model?: string;
    agent?: string;
    metadata?: Record<string, unknown>;
  };
}

interface OpenClawHookResult {
  modified?: boolean;
  context?: {
    model?: string;
    agent?: string;
    metadata?: Record<string, unknown>;
  };
}

// =============================================================================
// Routes Configuration
// =============================================================================

const ROUTES: Route[] = [
  // -------------------------------------------------------------------------
  // KIMI K2.5 - General conversation, research, documents, planning
  // -------------------------------------------------------------------------
  {
    name: 'general_conversation',
    model: 'kimi',
    utterances: [
      'how are you', 'hello', 'hi there', 'good morning', 'thanks',
      'what do you think', 'tell me about', 'explain', 'help me understand',
      'what is', 'who is', 'why is', 'when did', 'how does'
    ],
    threshold: 0.75
  },
  {
    name: 'research',
    model: 'kimi',
    utterances: [
      'research about', 'find information', 'look up', 'search for',
      'what are the latest', 'compare', 'analyze', 'summarize',
      'pros and cons', 'best practices', 'industry trends'
    ],
    threshold: 0.78
  },
  {
    name: 'documents',
    model: 'kimi',
    utterances: [
      'write a document', 'draft an email', 'create a report',
      'write a summary', 'edit this text', 'proofread', 'translate',
      'format this', 'create an outline', 'write content'
    ],
    threshold: 0.78
  },
  {
    name: 'planning',
    model: 'kimi',
    utterances: [
      'plan for', 'schedule', 'organize', 'prepare for',
      'what should i do', 'help me plan', 'create a roadmap',
      'prioritize', 'timeline for', 'steps to'
    ],
    threshold: 0.76
  },

  // -------------------------------------------------------------------------
  // MINIMAX M2.5 - Coding, UI/Frontend, bugs, files, APIs, agentic tasks
  // -------------------------------------------------------------------------
  {
    name: 'coding',
    model: 'minimax',
    utterances: [
      'write code', 'create function', 'implement', 'code this',
      'write a script', 'program', 'algorithm for', 'write python',
      'write javascript', 'write typescript', 'create a class',
      'make a function', 'code for', 'build a',
      'write hello world', 'hello world', 'fizzbuzz', 'fibonacci',
      'sort algorithm', 'binary search', 'linked list', 'todo app',
      'write a program', 'make a script', 'coding', 'code',
      'function that', 'class that', 'method that', 'loop',
      'regex for', 'parse', 'compile', 'runtime', 'syntax'
    ],
    threshold: 0.65
  },
  {
    name: 'ui_frontend',
    model: 'minimax',
    utterances: [
      'react component', 'ui for', 'frontend', 'css for',
      'html for', 'style this', 'create a page', 'design a form',
      'button that', 'layout for', 'responsive', 'tailwind',
      'component for', 'vue', 'svelte', 'next.js'
    ],
    threshold: 0.82
  },
  {
    name: 'bug_fix',
    model: 'minimax',
    utterances: [
      'fix this bug', 'debug this', 'error in', 'not working',
      'fix this code', 'why isnt this working', 'broken code',
      'fix the issue', 'solve this error', 'troubleshoot'
    ],
    threshold: 0.80
  },
  {
    name: 'file_operations',
    model: 'minimax',
    utterances: [
      'create a file', 'read file', 'write to file', 'modify file',
      'parse this file', 'json file', 'csv file', 'config file',
      'update the file', 'save to', 'load from'
    ],
    threshold: 0.78
  },
  {
    name: 'api_work',
    model: 'minimax',
    utterances: [
      'call api', 'fetch from', 'post to', 'api request',
      'rest api', 'graphql', 'endpoint', 'http request',
      'webhook', 'integrate with', 'api for'
    ],
    threshold: 0.80
  },
  {
    name: 'agentic_tasks',
    model: 'minimax',
    utterances: [
      'automate', 'run this', 'execute', 'do this for me',
      'set up', 'install', 'deploy', 'configure',
      'run tests', 'build project', 'start server'
    ],
    threshold: 0.78
  },

  // -------------------------------------------------------------------------
  // CLAUDE SONNET - Complex debugging, architecture, security (EXPENSIVE!)
  // Only use for truly complex problems or via escalation
  // -------------------------------------------------------------------------
  {
    name: 'complex_debugging',
    model: 'claude',
    utterances: [
      'stuck for hours', 'cant figure out', 'impossible bug',
      'complex issue', 'deep debugging', 'race condition',
      'memory leak', 'performance issue', 'mysterious error',
      'been trying for days', 'really stumped'
    ],
    threshold: 0.85
  },
  {
    name: 'architecture',
    model: 'claude',
    utterances: [
      'design architecture', 'system design', 'architectural decision',
      'design pattern', 'microservices', 'database schema',
      'scalability', 'high availability', 'distributed system',
      'architect this', 'design for scale'
    ],
    threshold: 0.85
  },
  {
    name: 'security_review',
    model: 'claude',
    utterances: [
      'security review', 'vulnerability', 'penetration test',
      'security audit', 'threat model', 'secure this',
      'authentication', 'authorization', 'encryption'
    ],
    threshold: 0.85
  }
];

// =============================================================================
// Failure Tracking (per-user escalation)
// =============================================================================

interface UserFailureState {
  consecutiveFailures: number;
  lastModel: 'kimi' | 'minimax' | 'claude';
  lastFailureTime: number;
}

const userFailures = new Map<string, UserFailureState>();
const MAX_FAILURES = 2;
const FAILURE_RESET_MS = 5 * 60 * 1000; // Reset after 5 minutes of no failures

// =============================================================================
// Semantic Similarity Functions
// =============================================================================

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function computeSimilarity(message: string, utterances: string[]): number {
  const msgTokens = new Set(tokenize(message));
  const msgLower = message.toLowerCase();
  let maxScore = 0;

  for (const utterance of utterances) {
    const uttTokens = tokenize(utterance);
    if (uttTokens.length === 0) continue;

    // Keyword recall: what fraction of utterance keywords are in the message?
    // This works much better than Jaccard for long messages vs short utterances.
    const matches = uttTokens.filter(t => msgTokens.has(t)).length;
    let score = matches / uttTokens.length;

    // Boost for exact phrase match
    if (msgLower.includes(utterance.toLowerCase())) {
      score = Math.min(score + 0.15, 1.0);
    }

    maxScore = Math.max(maxScore, score);
  }

  return maxScore;
}

// =============================================================================
// Coding Keyword Detection
// =============================================================================

/** Programming languages, frameworks, and coding-related keywords.
 *  If ANY of these appear in the message, boost MiniMax coding route. */
const CODING_KEYWORDS = new Set([
  // Languages
  'python', 'javascript', 'typescript', 'java', 'rust', 'golang', 'ruby',
  'php', 'swift', 'kotlin', 'scala', 'haskell', 'elixir', 'clojure',
  'cpp', 'c++', 'csharp', 'c#', 'lua', 'perl', 'bash', 'sql', 'html', 'css',
  // Frameworks / tools
  'react', 'vue', 'angular', 'nextjs', 'express', 'fastify', 'django',
  'flask', 'rails', 'spring', 'node', 'deno', 'bun', 'webpack', 'vite',
  'docker', 'kubernetes', 'terraform', 'ansible', 'git', 'npm', 'pip',
  // Concepts
  'function', 'class', 'variable', 'array', 'object', 'string', 'integer',
  'boolean', 'loop', 'recursion', 'async', 'await', 'promise', 'callback',
  'api', 'endpoint', 'database', 'query', 'schema', 'migration', 'test',
  'regex', 'parse', 'compile', 'debug', 'error', 'bug', 'fix', 'refactor',
  'fibonacci', 'fizzbuzz', 'sorting', 'algorithm', 'leetcode',
  'todo', 'crud', 'rest', 'graphql', 'websocket', 'server', 'client',
  // Code-adjacent verbs
  'implement', 'deploy', 'install', 'configure', 'build', 'compile', 'run',
]);

/** Classic coding phrases that should always route to MiniMax,
 *  even if individual words might match other routes. */
const CODING_PHRASES = [
  'hello world', 'fizzbuzz', 'todo app', 'crud app',
  'binary search', 'linked list', 'bubble sort', 'merge sort',
  'quick sort', 'depth first', 'breadth first',
];

/** Check if message contains coding-related keywords or phrases. */
function hasCodingKeywords(message: string): boolean {
  const lower = message.toLowerCase();
  // Check exact coding phrases first (e.g., "hello world")
  if (CODING_PHRASES.some(p => lower.includes(p))) return true;
  // Check individual coding keywords
  const tokens = tokenize(message);
  return tokens.some(t => CODING_KEYWORDS.has(t));
}

// =============================================================================
// Routing Logic
// =============================================================================

function routeMessage(message: string, userId: string): RoutingResult {
  // Check if user should be escalated due to failures
  const failureState = userFailures.get(userId);
  if (failureState) {
    const timeSinceFailure = Date.now() - failureState.lastFailureTime;
    if (timeSinceFailure > FAILURE_RESET_MS) {
      // Reset failures after timeout
      userFailures.delete(userId);
    } else if (failureState.consecutiveFailures >= MAX_FAILURES) {
      // Escalate to Claude
      return {
        route: 'escalation',
        model: 'claude',
        confidence: 1.0,
        escalated: true
      };
    }
  }

  // Score all routes
  const scores: { route: Route; score: number }[] = [];
  const codingDetected = hasCodingKeywords(message);

  for (const route of ROUTES) {
    let score = computeSimilarity(message, route.utterances);

    // Boost MiniMax routes when coding keywords are detected.
    // This ensures short prompts like "write hello world" or "python fibonacci"
    // get routed to MiniMax even if they don't match utterance phrases exactly.
    if (codingDetected && route.model === 'minimax') {
      score = Math.min(score + 0.25, 1.0);
    }
    // Penalize kimi general_conversation when coding is detected.
    // Prevents "write hello world" from routing to general_conversation
    // just because "hello" matches a greeting utterance.
    // Only penalize generic kimi routes, NOT claude (complex debugging) or research.
    if (codingDetected && route.name === 'general_conversation') {
      score = Math.max(score - 0.30, 0);
    }

    if (score >= route.threshold) {
      scores.push({ route, score });
    }
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  if (scores.length > 0) {
    const best = scores[0];
    return {
      route: best.route.name,
      model: best.route.model,
      confidence: best.score,
      escalated: false
    };
  }

  // If coding keywords detected but no route matched above threshold,
  // force route to MiniMax coding route.
  if (codingDetected) {
    return {
      route: 'coding',
      model: 'minimax',
      confidence: 0.6,
      escalated: false
    };
  }

  // Default to Kimi for general/unknown messages
  return {
    route: 'default',
    model: 'kimi',
    confidence: 0.5,
    escalated: false
  };
}

function recordFailure(userId: string, model: 'kimi' | 'minimax' | 'claude'): void {
  const state = userFailures.get(userId) || {
    consecutiveFailures: 0,
    lastModel: model,
    lastFailureTime: Date.now()
  };

  state.consecutiveFailures++;
  state.lastModel = model;
  state.lastFailureTime = Date.now();

  userFailures.set(userId, state);
}

function recordSuccess(userId: string): void {
  userFailures.delete(userId);
}

// =============================================================================
// Model Mapping
// =============================================================================

// Models are routed through the JARVIT AI Proxy in the gateway
// Container NEVER calls model APIs directly - ensures:
// 1. No API keys in container
// 2. All usage tracked per user
// 3. Credits enforced before each call

const MODEL_MAP: Record<'kimi' | 'minimax' | 'claude', string> = {
  kimi: 'jarvit/kimi',       // → AI Proxy → Kimi API
  minimax: 'jarvit/minimax',  // → AI Proxy → MiniMax API
  claude: 'jarvit/claude',    // → AI Proxy → Anthropic API
};

const AGENT_MAP: Record<'kimi' | 'minimax' | 'claude', string> = {
  kimi: 'general',
  minimax: 'general',
  claude: 'general',
};

// =============================================================================
// OpenClaw Hook Export
// =============================================================================

/**
 * beforeRequest hook - intercepts every message before it's sent to a model
 * Routes to the appropriate model based on semantic intent
 */
export function beforeRequest(request: OpenClawRequest): OpenClawHookResult {
  const { userId, message } = request;

  // Only route user messages
  if (message.role !== 'user') {
    return { modified: false };
  }

  const routing = routeMessage(message.content, userId);

  console.log(`[jarvit-router] User ${userId}: "${message.content.slice(0, 50)}..."`);
  console.log(`[jarvit-router] Route: ${routing.route} -> ${routing.model} (${(routing.confidence * 100).toFixed(1)}%)`);

  if (routing.escalated) {
    console.log(`[jarvit-router] ESCALATED to Opus after ${MAX_FAILURES} failures`);
  }

  return {
    modified: true,
    context: {
      model: MODEL_MAP[routing.model],
      agent: AGENT_MAP[routing.model],
      metadata: {
        route: routing.route,
        confidence: routing.confidence,
        escalated: routing.escalated,
        originalModel: request.context?.model
      }
    }
  };
}

/**
 * afterResponse hook - tracks success/failure for escalation
 */
export function afterResponse(
  request: OpenClawRequest,
  response: { success: boolean; error?: string }
): void {
  const { userId } = request;
  const metadata = request.context?.metadata as { route?: string } | undefined;

  if (response.success) {
    recordSuccess(userId);
  } else {
    // Determine which model failed from the request context
    const model = request.context?.model;
    if (model?.includes('kimi')) {
      recordFailure(userId, 'kimi');
    } else if (model?.includes('minimax')) {
      recordFailure(userId, 'minimax');
    } else if (model?.includes('claude')) {
      recordFailure(userId, 'claude');
    }
  }
}

// =============================================================================
// Exports for Testing
// =============================================================================

export {
  routeMessage,
  recordFailure,
  recordSuccess,
  ROUTES,
  MODEL_MAP,
  AGENT_MAP
};
