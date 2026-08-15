// The Fixer: an agent with a computer. It seeds a tiny project in its sandbox,
// watches the test fail, patches it, re-runs to green — then parks at the
// boundary: export() carries an 'ask' gate, so the file only leaves the box
// after a human approves. Kill the server anywhere in that story; it resumes.
// Fork it before the patch and the branch gets the filesystem AS IT WAS.
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { mockModel } from 'meteor/durable:agent';

export const Workbench = Meteor.sandbox({
  name: 'workbench',
  image: 'node:22-bookworm',
  limits: { cpus: 1, mem: '512m' },
  net: 'deny',                                // nothing gets out except export()
  idle: '75 s',                               // short, so the demo shows hibernation
});

// Deterministic scripted policy — phases keyed off the (journaled) tool history.
const fixerModel = mockModel((messages) => {
  const users = messages.filter((m) => m.role === 'user');
  const rewrite = users.some((m) => /rewrite|scratch/i.test(String(m.content)));
  const tools = messages.filter((m) => m.role === 'tool');
  const count = (n) => tools.filter((t) => t.name === n).length;
  const writes = count('write_file');
  const execs = count('exec');

  if (count('export') >= 1) return { content: 'Patch exported — done.', toolCalls: [] };
  if (writes === 0) {
    return {
      content: 'Setting up the project in my sandbox.',
      toolCalls: [
        { name: 'write_file', args: { path: 'package.json', content: '{"name":"demo","scripts":{"test":"node test.js"}}\n' } },
        { name: 'write_file', args: { path: 'sum.js', content: 'module.exports = (a, b) => a - b;\n' } },
        { name: 'write_file', args: { path: 'test.js', content: "const sum = require('./sum');\nif (sum(2, 2) !== 4) { console.error('FAIL: sum(2,2) = ' + sum(2, 2)); process.exit(1); }\nconsole.log('PASS');\n" } },
      ],
    };
  }
  if (execs === 0) return { content: 'Running the tests.', toolCalls: [{ name: 'exec', args: { cmd: 'npm test' } }] };

  if (rewrite) {
    // the fork branch: prove the seeded filesystem first, then start over
    if (count('read_file') === 0) {
      return { content: 'Rewriting from scratch — checking what is on disk in THIS timeline first.', toolCalls: [{ name: 'read_file', args: { path: 'sum.js' } }] };
    }
    if (writes === 3) return { content: 'Confirmed the buggy original is here. Rewriting.', toolCalls: [{ name: 'write_file', args: { path: 'sum.js', content: 'module.exports = (a, b) => Number(a) + Number(b);\n' } }] };
    if (execs === 1) return { content: 'Re-running tests on the rewrite.', toolCalls: [{ name: 'exec', args: { cmd: 'npm test' } }] };
    return { content: 'Rewrite passes. No export in this branch.', toolCalls: [] };
  }

  if (writes === 3) return { content: 'sum() subtracts — patching it to add.', toolCalls: [{ name: 'write_file', args: { path: 'sum.js', content: 'module.exports = (a, b) => a + b;\n' } }] };
  if (execs === 1) return { content: 'Re-running the tests.', toolCalls: [{ name: 'exec', args: { cmd: 'npm test' } }] };
  return { content: 'Tests pass. Exporting the fix — needs your ok to leave the box.', toolCalls: [{ name: 'export', args: { path: 'sum.js' } }] };
});
Meteor.agent.model('fixer-mock', fixerModel);

export const Fixer = Meteor.agent({
  name: 'fixer',
  model: 'fixer-mock',
  instructions: 'Fix the failing test in your sandbox. Export the fix for approval.',
  sandbox: Workbench,                          // injects exec/write_file/read_file + gated export
  budget: { turns: 4, steps: 12, idle: '2 h', approval: '30 m' },
});

Meteor.methods({
  async 'sandboxdemo.start'() {
    const id = `fix-${Random.id(6)}`;
    await Fixer(id).say('fix the failing test');
    return id;
  },
});
