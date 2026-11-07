import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { CODEX_PREDEFINED_MODELS } from '@/modules/providers/list/codex/codex-models.provider.js';

const require = createRequire(import.meta.url);

const findCodexModel = (value: string) =>
  CODEX_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === value);

test('defaults to GPT-6.1 Sol and lists it first', () => {
  assert.equal(CODEX_PREDEFINED_MODELS.DEFAULT, 'gpt-6.1-sol');
  assert.equal(CODEX_PREDEFINED_MODELS.OPTIONS[0]?.value, 'gpt-6.1-sol');
});

test('lists GPT-6.1 models with names and reasoning metadata from codex debug models', () => {
  for (const [slug, label] of [
    ['gpt-6.1-sol', 'GPT-6.1-Sol'],
    ['gpt-6.1-terra', 'GPT-6.1 Terra'],
  ]) {
    const model = findCodexModel(slug);
    assert.equal(model?.label, label);
    assert.equal(model?.effort?.default, 'low');
    assert.deepEqual(
      model?.effort?.values.map((effort) => effort.value),
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    );
    assert.equal(CODEX_PREDEFINED_MODELS.OPTIONS.filter((option) => option.value === slug).length, 1);
  }
});

test('lists GPT-6 Sol and GPT-6 Luna with the effort levels the Codex CLI accepts', () => {
  const sol = findCodexModel('gpt-6-sol');
  assert.equal(sol?.label, 'GPT-6 Sol');
  assert.equal(sol?.effort?.default, 'medium');
  assert.deepEqual(
    sol?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );

  const luna = findCodexModel('gpt-6-luna');
  assert.equal(luna?.label, 'GPT-6 Luna');
  assert.equal(luna?.effort?.default, 'medium');
  assert.deepEqual(
    luna?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
});

test('bundles a Codex CLI new enough to know the GPT-6 Sol and Luna models', () => {
  // Codex only ships metadata for gpt-6-sol / gpt-6-luna from 0.155.0 on. An
  // older CLI still sends the request, but on fallback metadata: it warns
  // "Model metadata ... not found" and quietly drops `ultra` to `medium`.
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 155, `bundled @openai/codex ${version} predates 0.155.0`);
});
