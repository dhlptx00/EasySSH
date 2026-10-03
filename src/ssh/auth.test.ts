import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { utils } from 'ssh2';
import { AuthPlanner, looksLikePasswordPrompt, type AskAnswer, type AskRequest, type AuthContext, type AuthEndpoint } from './auth';
import { TransferCancelled } from './errors';

type Attempt = Parameters<Parameters<AuthPlanner['handler']>[2]>[0];
type Prompt = { prompt: string; echo?: boolean };

const server: AuthEndpoint = { host: 'web01', port: 22, username: 'dev', auth: 'password', main: true };

function context(answers: (AskAnswer | undefined)[] = [], extra: Partial<AuthContext> = {}): AuthContext & { asked: AskRequest[] } {
  const asked: AskRequest[] = [];
  return {
    askPassword: false,
    identityFiles: [],
    readKey: () => {
      throw new Error('no key');
    },
    ask: async (request) => {
      asked.push(request);
      return answers.shift();
    },
    log: () => {},
    ...extra,
    asked,
  };
}

function step(planner: AuthPlanner, methods: string[] | null, partial: boolean | null = false): Promise<Attempt> {
  return new Promise((resolve) => planner.handler(methods, partial, resolve));
}

function answer(attempt: Attempt, prompts: Prompt[], name = '', instructions = ''): Promise<string[]> {
  assert.ok(attempt && attempt.type === 'keyboard-interactive');
  return new Promise((resolve) => attempt.prompt(name, instructions, '', prompts, resolve));
}

/**
 * ssh2's generateKeyPairSync('ed25519') now and then (about 1 in 200) returns a
 * key its own parseKey rejects as malformed. Real keys come from ssh-keygen, so
 * only the test fixtures need this: generate until the key parses.
 */
function keyPair(options?: { passphrase: string; cipher: string; rounds: number }): { private: string; public: string } {
  for (;;) {
    const pair = options ? utils.generateKeyPairSync('ed25519', options) : utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private, options?.passphrase) instanceof Error)) return pair;
  }
}

describe('authentication planner', () => {
  it('tries the saved password once, then asks, up to three times (S3)', async () => {
    const ctx = context([{ value: 'typed1', save: true }, { value: 'typed2', save: false }, { value: 'typed3', save: false }], { savedPassword: 'saved' });
    const planner = new AuthPlanner(server, ctx);
    assert.deepEqual(await step(planner, null), { type: 'none', username: 'dev' });
    assert.deepEqual(await step(planner, ['password']), { type: 'password', username: 'dev', password: 'saved' });
    assert.deepEqual(await step(planner, ['password']), { type: 'password', username: 'dev', password: 'typed1' });
    assert.equal(ctx.asked[0].title, 'Wrong password. Try again');
    assert.equal(ctx.asked[0].save, true);
    assert.deepEqual(planner.typed, { value: 'typed1', save: true });
    assert.equal((await step(planner, ['password']) as { password: string }).password, 'typed2');
    assert.equal(await step(planner, ['password']), false);
    assert.match(planner.explain(), /Wrong user name or password for dev@web01/);
  });

  it('never offers to save when the connection asks each time', async () => {
    const ctx = context([{ value: 'pw', save: false }], { askPassword: true });
    const planner = new AuthPlanner(server, ctx);
    await step(planner, null);
    assert.equal((await step(planner, ['password']) as { password: string }).password, 'pw');
    assert.equal(ctx.asked[0].save, undefined);
  });

  it('sends the saved password only to one hidden password prompt (S2)', async () => {
    const ctx = context([{ value: '123456', save: false }], { savedPassword: 'saved' });
    const planner = new AuthPlanner(server, ctx);
    await step(planner, null);
    const kbd = await step(planner, ['keyboard-interactive']);
    assert.deepEqual(await answer(kbd, [{ prompt: 'Password: ', echo: false }]), ['saved']);
    // The OTP that follows (same round, or a new round after partial success) is asked in the terminal.
    assert.deepEqual(await answer(kbd, [{ prompt: 'Verification code: ', echo: false }], 'Duo', 'Enter your code'), ['123456']);
    assert.equal(ctx.asked.length, 1);
    assert.equal(ctx.asked[0].label, 'Verification code');
    assert.equal(ctx.asked[0].detail, 'Duo\nEnter your code');
    assert.equal(ctx.asked[0].save, undefined);
    const second = await step(planner, ['keyboard-interactive'], true);
    assert.ok(second && second.type === 'keyboard-interactive');
  });

  it('asks instead of guessing when a round has several prompts', async () => {
    const ctx = context([{ value: 'u', save: false }, { value: 'p', save: false }], { savedPassword: 'saved' });
    const planner = new AuthPlanner(server, ctx);
    await step(planner, null);
    const kbd = await step(planner, ['keyboard-interactive']);
    assert.deepEqual(await answer(kbd, [{ prompt: 'Username:', echo: true }, { prompt: 'Password:', echo: false }]), ['u', 'p']);
    assert.equal(ctx.asked[0].masked, false);
    assert.equal(ctx.asked[1].masked, true);
  });

  it('does not reuse the saved password on keyboard-interactive after it failed as a password', async () => {
    const ctx = context([{ value: 'typed', save: false }], { savedPassword: 'saved' });
    const planner = new AuthPlanner(server, ctx);
    await step(planner, null);
    await step(planner, ['password', 'keyboard-interactive']);
    // Password retries come first; pretend the server now only allows keyboard-interactive.
    const kbd = await step(planner, ['keyboard-interactive']);
    assert.deepEqual(await answer(kbd, [{ prompt: 'Password:', echo: false }]), ['typed']);
  });

  it('stops quietly when a prompt is cancelled', async () => {
    const planner = new AuthPlanner(server, context([undefined]));
    await step(planner, null);
    assert.equal(await step(planner, ['password']), false);
    assert.ok(planner.stopReason instanceof TransferCancelled);
  });

  it('asks for the key passphrase and retries a wrong one (S3)', async () => {
    const pair = keyPair({ passphrase: 'right', cipher: 'aes256-ctr', rounds: 4 });
    const ctx = context([{ value: 'wrong', save: false }, { value: 'right', save: false }], { readKey: () => Buffer.from(pair.private) });
    const planner = new AuthPlanner({ ...server, auth: 'privateKey', privateKeyPath: '/home/me/.ssh/id_ed25519' }, ctx);
    await step(planner, null);
    const attempt = await step(planner, ['publickey']);
    assert.ok(attempt && attempt.type === 'publickey');
    assert.equal(attempt.passphrase, 'right');
    assert.deepEqual(ctx.asked.map((item) => item.title), ['Key passphrase', 'Wrong passphrase. Try again']);
    assert.equal(ctx.asked[0].label, 'passphrase for id_ed25519');
  });

  it('uses the saved passphrase without asking', async () => {
    const pair = keyPair({ passphrase: 'pp', cipher: 'aes256-ctr', rounds: 4 });
    const ctx = context([], { readKey: () => Buffer.from(pair.private), savedPassphrase: { keyPath: '/k', passphrase: 'pp' } });
    const planner = new AuthPlanner({ ...server, auth: 'privateKey', privateKeyPath: '/k' }, ctx);
    await step(planner, null);
    const attempt = await step(planner, ['publickey']);
    assert.ok(attempt && attempt.type === 'publickey' && attempt.passphrase === 'pp');
    assert.equal(ctx.asked.length, 0);
  });

  it('tries the agent, then the default key files, like ssh (F7)', async () => {
    const pair = keyPair();
    const ctx = context([], {
      agent: '/tmp/agent.sock',
      identityFiles: ['/home/me/.ssh/id_ed25519', '/home/me/.ssh/id_rsa'],
      readKey: (file) => {
        if (file.endsWith('id_rsa')) throw new Error('ENOENT');
        return Buffer.from(pair.private);
      },
    });
    const planner = new AuthPlanner({ ...server, auth: 'agent' }, ctx);
    await step(planner, null);
    assert.deepEqual(await step(planner, ['publickey']), { type: 'agent', username: 'dev', agent: '/tmp/agent.sock' });
    const key = await step(planner, ['publickey']);
    assert.ok(key && key.type === 'publickey');
    assert.equal(await step(planner, ['publickey']), false);
  });

  it('explains what to try next (U11)', async () => {
    const noAgent = new AuthPlanner({ ...server, auth: 'agent' }, context());
    await step(noAgent, null);
    assert.equal(await step(noAgent, ['publickey']), false);
    assert.match(noAgent.explain(), /No SSH agent is running/);

    const keyOnly = new AuthPlanner(server, context());
    await step(keyOnly, null);
    assert.equal(await step(keyOnly, ['publickey']), false);
    assert.match(keyOnly.explain(), /does not accept passwords \(it allows: publickey\)/);

    const key = new AuthPlanner({ ...server, auth: 'privateKey', privateKeyPath: '/k/id_ed25519' }, context([], { readKey: () => Buffer.from(keyPair().private) }));
    await step(key, null);
    await step(key, ['publickey']);
    assert.equal(await step(key, ['publickey']), false);
    assert.match(key.explain(), /did not accept id_ed25519.*authorized_keys/);
  });

  it('tells password prompts from one-time codes', () => {
    assert.ok(looksLikePasswordPrompt('Password: '));
    assert.ok(looksLikePasswordPrompt("dev@web01's password:"));
    assert.ok(looksLikePasswordPrompt('密码：'));
    assert.ok(!looksLikePasswordPrompt('Verification code:'));
    assert.ok(!looksLikePasswordPrompt('Duo two-factor login passcode'));
    assert.ok(!looksLikePasswordPrompt('One-time password (OTP):'));
  });
});
