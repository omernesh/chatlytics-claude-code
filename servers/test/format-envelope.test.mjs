// chatlytics#951/#956: the listener's line for a turn the owner summoned.
//
// test/fixtures/from-me-envelopes.json is a byte-identical copy of the fixture
// chatlytics pins to the envelope its real inbound pipeline builds
// (tests/fixtures/from-me-envelopes.json there).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { formatEnvelope } from '../lib/format-envelope.mjs';

const ENVELOPES = JSON.parse(readFileSync(new URL('./fixtures/from-me-envelopes.json', import.meta.url), 'utf8'));
const NAMES = { [ENVELOPES.from_me_dm.sender_jid]: 'Omer', [ENVELOPES.third_party_dm.sender_jid]: 'Dana Levi' };
const resolveName = async (jid) => NAMES[jid] ?? '';

test('a fromMe DM names the owner, the chat and who reads the reply', async () => {
  const line = await formatEnvelope(ENVELOPES.from_me_dm, resolveName);
  assert.match(line, /^whatsapp message from Omer, your owner, in their chat with Dana Levi: "!sammie summarize this chat"/);
  assert.ok(line.includes(`chat ${ENVELOPES.from_me_dm.entity_jid}`));
  assert.ok(line.includes(`session ${ENVELOPES.from_me_dm.session_id}`));
  assert.ok(line.includes('Dana Levi reads it'));
  assert.ok(!line.includes('[SECURITY:'));
});

test('a fromMe group names the group and its audience', async () => {
  const line = await formatEnvelope(ENVELOPES.from_me_group, resolveName);
  assert.match(line, /^whatsapp message from Omer, your owner, in the group Family: /);
  assert.ok(line.includes('everyone in the group reads it'));
});

test('a normal third-party DM is the sender speaking, with no owner claim', async () => {
  const line = await formatEnvelope(ENVELOPES.third_party_dm, resolveName);
  assert.equal(line, 'whatsapp message from Dana Levi: "!sammie hi"');
});

test('a fromMe DM with no name falls back to the number', async () => {
  const { chat_name: _name, ...env } = ENVELOPES.from_me_dm;
  const line = await formatEnvelope(env, async () => '');
  assert.ok(line.includes(`their chat with ${env.entity_jid.split('@')[0]}`));
});

test('a normal group message keeps its existing shape', async () => {
  const { trigger_source: _source, ...env } = ENVELOPES.from_me_group;
  const line = await formatEnvelope(env, resolveName);
  assert.equal(line, `whatsapp message from Omer in Family: "!sammie what's the plan"`);
});
