// Shared between server and client: the transcript IS the workflow journal,
// so both sides derive messages/status/usage from the same run doc.

export const STOP = '__stop__';

export const runIdFor = (name, key) => `agent:${name}:${key}`;

// Rough token estimate (chars/4) — used for compaction thresholds and mock usage.
export const estTokens = (msgs) => Math.ceil(JSON.stringify(msgs).length / 4);

/** Journal → chat messages. Steering, interrupts, approvals and compactions all
 *  leave journal entries, so the rendered transcript shows the whole story —
 *  including what a fork replayed. Full history survives compaction (compaction
 *  only changes what the MODEL sees; the journal keeps everything). */
export function journalToMessages(journal = []) {
  const out = [];
  for (const e of journal) {
    if (e.type === 'receive' && e.signal === 'say') {
      if (e.timedOut || !e.payload?.text || e.payload.text === STOP) continue;
      out.push({ role: 'user', content: e.payload.text, at: e.at });
    } else if (e.type === 'drain' && e.signal === 'say') {
      for (const p of e.payloads) out.push({ role: 'user', content: p.text, steering: true, at: e.at });
    } else if (e.type === 'drain' && e.signal === 'interrupt') {
      out.push({ role: 'note', kind: 'interrupted', hard: e.payloads.some((p) => p.hard), at: e.at });
    } else if (e.type === 'receive' && e.signal === 'approval') {
      if (e.timedOut) out.push({ role: 'note', kind: 'approval-timeout', at: e.at });
      else out.push({ role: 'note', kind: e.payload?.approved ? 'approved' : 'denied', by: e.payload?.by, reason: e.payload?.reason, at: e.at });
    } else if (e.type === 'step' && /^think#/.test(e.label)) {
      if (e.failed) out.push({ role: 'note', kind: 'error', error: e.error, at: e.at });
      else out.push({ role: 'assistant', content: e.result?.content, toolCalls: e.result?.toolCalls || [], usage: e.result?.usage, at: e.at });
    } else if (e.type === 'step' && /^compact#/.test(e.label)) {
      out.push({ role: 'note', kind: 'compacted', upto: e.result?.upto, summary: e.result?.summary, at: e.at });
    } else if (e.type === 'step' && /^(act|cosign|ask):/.test(e.label)) {
      const m = /^(\w+):([^#]+)#/.exec(e.label);
      out.push({ role: 'tool', tool: m?.[2], gate: m?.[1], result: e.failed ? { ok: false, error: e.error } : e.result, at: e.at });
    }
  }
  return out;
}

/** Harness-level status, derived from the run doc. */
export function statusOf(doc) {
  if (!doc) return 'idle';
  if (doc.status === 'done') return doc.result?.ended === 'stopped' ? 'stopped' : 'done';
  if (doc.status === 'failed') return 'failed';
  if (doc.status === 'waiting_signal') {
    return doc.waitingFor?.signal === 'approval' ? 'awaiting-approval' : 'idle';
  }
  const step = doc.currentStep || '';
  if (/^(cosign|approve):/.test(step)) return 'awaiting-approval';
  if (step.startsWith('think')) return 'thinking';
  if (step.startsWith('compact')) return 'compacting';
  if (/^(act|ask):/.test(step)) return 'working';
  return doc.status || 'idle';
}

/** Token totals, summed from journaled model calls (thinks + compactions).
 *  Recomputed from the journal, so it is always consistent after a resume. */
export function usageOf(journal = []) {
  const u = { input: 0, output: 0, calls: 0 };
  for (const e of journal) {
    if (e.type === 'step' && /^(think|compact)#/.test(e.label) && e.result?.usage) {
      u.input += e.result.usage.input || 0;
      u.output += e.result.usage.output || 0;
      u.calls += 1;
    }
  }
  return u;
}

/** $ cost of a usage total under a {input, output} $-per-Mtok pricing. */
export function costOf(usage, pricing) {
  if (!pricing) return null;
  return (usage.input * (pricing.input || 0) + usage.output * (pricing.output || 0)) / 1e6;
}
