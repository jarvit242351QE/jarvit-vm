/**
 * JARVIT Router Plugin Tests
 *
 * Verifies semantic intent routing works correctly
 */

import { routeMessage, recordFailure, ROUTES } from './index.js';

// Test cases for each route type
const testCases = [
  // KIMI - General conversation
  { message: 'Hello, how are you today?', expectedModel: 'kimi', expectedRoute: 'general_conversation' },
  { message: 'What do you think about AI?', expectedModel: 'kimi', expectedRoute: 'general_conversation' },
  { message: 'Explain quantum computing to me', expectedModel: 'kimi', expectedRoute: 'general_conversation' },

  // KIMI - Research
  { message: 'Research the latest trends in machine learning', expectedModel: 'kimi', expectedRoute: 'research' },
  { message: 'Find information about climate change', expectedModel: 'kimi', expectedRoute: 'research' },
  { message: 'Compare React vs Vue for my project', expectedModel: 'kimi', expectedRoute: 'research' },

  // KIMI - Documents
  { message: 'Write a summary of this article', expectedModel: 'kimi', expectedRoute: 'documents' },
  { message: 'Draft an email to my boss', expectedModel: 'kimi', expectedRoute: 'documents' },
  { message: 'Create a report on our quarterly sales', expectedModel: 'kimi', expectedRoute: 'documents' },

  // MINIMAX - Coding
  { message: 'Write a Python function to sort a list', expectedModel: 'minimax', expectedRoute: 'coding' },
  { message: 'Create a class for user authentication', expectedModel: 'minimax', expectedRoute: 'coding' },
  { message: 'Implement a binary search algorithm', expectedModel: 'minimax', expectedRoute: 'coding' },

  // MINIMAX - UI/Frontend
  { message: 'Create a React component for a login form', expectedModel: 'minimax', expectedRoute: 'ui_frontend' },
  { message: 'Design a responsive navbar with Tailwind', expectedModel: 'minimax', expectedRoute: 'ui_frontend' },
  { message: 'Build a Vue component for user profile', expectedModel: 'minimax', expectedRoute: 'ui_frontend' },

  // MINIMAX - Bug fixes
  { message: 'Fix this bug in my code', expectedModel: 'minimax', expectedRoute: 'bug_fix' },
  { message: 'Debug this function that is not working', expectedModel: 'minimax', expectedRoute: 'bug_fix' },
  { message: 'Troubleshoot why this returns undefined', expectedModel: 'minimax', expectedRoute: 'bug_fix' },

  // MINIMAX - API work
  { message: 'Make an API request to fetch user data', expectedModel: 'minimax', expectedRoute: 'api_work' },
  { message: 'Create a REST API endpoint for products', expectedModel: 'minimax', expectedRoute: 'api_work' },
  { message: 'Integrate with the Stripe webhook', expectedModel: 'minimax', expectedRoute: 'api_work' },

  // OPUS - Complex debugging (should require explicit signals)
  { message: "I've been stuck on this bug for hours, can't figure it out", expectedModel: 'opus', expectedRoute: 'complex_debugging' },
  { message: 'There is a mysterious memory leak in production', expectedModel: 'opus', expectedRoute: 'complex_debugging' },

  // OPUS - Architecture
  { message: 'Design the architecture for a scalable chat application', expectedModel: 'opus', expectedRoute: 'architecture' },
  { message: 'Help me with system design for high availability', expectedModel: 'opus', expectedRoute: 'architecture' },
];

// Run tests
console.log('=== JARVIT Router Tests ===\n');

let passed = 0;
let failed = 0;

for (const test of testCases) {
  const result = routeMessage(test.message, 'test_user');

  const modelMatch = result.model === test.expectedModel;
  const routeMatch = result.route === test.expectedRoute;
  const success = modelMatch && routeMatch;

  if (success) {
    passed++;
    console.log(`✅ "${test.message.slice(0, 40)}..."`);
    console.log(`   → ${result.model}/${result.route} (${(result.confidence * 100).toFixed(0)}%)`);
  } else {
    failed++;
    console.log(`❌ "${test.message.slice(0, 40)}..."`);
    console.log(`   Expected: ${test.expectedModel}/${test.expectedRoute}`);
    console.log(`   Got: ${result.model}/${result.route} (${(result.confidence * 100).toFixed(0)}%)`);
  }
}

console.log(`\n=== Results ===`);
console.log(`Passed: ${passed}/${testCases.length}`);
console.log(`Failed: ${failed}/${testCases.length}`);
console.log(`Accuracy: ${((passed / testCases.length) * 100).toFixed(1)}%`);

// Test escalation
console.log('\n=== Escalation Tests ===\n');

const userId = 'escalation_test_user';

// Simulate 2 failures
recordFailure(userId, 'kimi');
recordFailure(userId, 'kimi');

// Next request should escalate to Claude
const escalatedResult = routeMessage('Hello there', userId);

if (escalatedResult.escalated && escalatedResult.model === 'claude') {
  console.log('✅ Escalation works: After 2 failures, routes to Claude');
} else {
  console.log('❌ Escalation failed');
  console.log(`   Expected: escalated=true, model=claude`);
  console.log(`   Got: escalated=${escalatedResult.escalated}, model=${escalatedResult.model}`);
}

console.log('\n=== All Tests Complete ===');
