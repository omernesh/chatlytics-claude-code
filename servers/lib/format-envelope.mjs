/**
 * The clean inbox line for one inbound envelope. Used by the WhatsApp listener
 * (daemon/wa-poll-once.mjs); the line goes to the model, never to WhatsApp.
 *
 * `resolveName(jid)` is the listener's best-effort directory lookup ('' on a miss).
 */

export function localPart(jid) {
  if (!jid) return '';
  const i = String(jid).indexOf('@');
  return i > 0 ? String(jid).slice(0, i) : String(jid);
}

export function stripSecurity(text) {
  if (!text) return '';
  const lines = String(text).split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trimStart().startsWith('[SECURITY:')) i++;
  return lines.slice(i).join('\n').trim();
}

export async function formatEnvelope(env, resolveName) {
  const senderJid = env.sender_jid ?? env.entity_jid ?? '';
  let sender = (env.sender_name && String(env.sender_name).trim()) || '';
  if (!sender) sender = (await resolveName(senderJid)) || localPart(senderJid) || 'unknown';
  const text = stripSecurity(env.text ?? '');
  const editTag = env.edited === true ? ' (edited)' : '';
  const chatName = async (fallback) =>
    (env.chat_name && String(env.chat_name).trim()) ||
    (await resolveName(env.entity_jid)) ||
    localPart(env.entity_jid) ||
    fallback;
  // chatlytics#956: the owner typed this on their own number and summoned the bot
  // into someone's chat. sender_jid is the owner (#951), so say whose chat it is
  // and who reads the reply: it goes there, from the owner's number.
  if (env.trigger_source === 'from_me') {
    const isGroup = env.chat_type === 'group';
    const chat = await chatName(isGroup ? 'group' : 'contact');
    const place = isGroup ? `the group ${chat}` : `their chat with ${chat}`;
    const audience = isGroup ? 'everyone in the group reads it' : `${chat} reads it`;
    return `whatsapp message from ${sender}${editTag}, your owner, in ${place}: "${text}" `
      + `(reply goes to chat ${env.entity_jid} from the owner's number, session ${env.session_id}; ${audience})`;
  }
  if (env.chat_type === 'group') {
    const grp = await chatName('group');
    return `whatsapp message from ${sender}${editTag} in ${grp}: "${text}"`;
  }
  return `whatsapp message from ${sender}${editTag}: "${text}"`;
}
