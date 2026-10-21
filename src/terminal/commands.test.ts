import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultSlashPick, isReservedCommand, matchSlashCommands, parseConnectionCommand, parseSessionCommand, rawConnectionToken } from './commands';

describe('connection commands', () => {
  it('connects when the line is empty', () => {
    assert.deepEqual(parseConnectionCommand(''), { type: 'connect' });
    assert.deepEqual(parseConnectionCommand('   '), { type: 'connect' });
  });

  it('accepts add, edit, and delete', () => {
    assert.deepEqual(parseConnectionCommand('/new'), { type: 'new' });
    assert.deepEqual(parseConnectionCommand('/add'), { type: 'new' });
    assert.deepEqual(parseConnectionCommand('/Edit'), { type: 'edit' });
    assert.deepEqual(parseConnectionCommand('/modify'), { type: 'edit' });
    assert.deepEqual(parseConnectionCommand('/delete'), { type: 'delete' });
    assert.deepEqual(parseConnectionCommand('/rm'), { type: 'delete' });
  });

  it('rejects a command without a slash', () => {
    assert.deepEqual(parseConnectionCommand('new'), { type: 'unknown', text: 'new' });
    assert.deepEqual(parseConnectionCommand('/new extra'), { type: 'unknown', text: '/new extra' });
  });

  it('lists and filters slash commands', () => {
    assert.deepEqual(matchSlashCommands('/').map((command) => command.name), ['new', 'edit', 'delete', 'import', 'folder', 'quit']);
    assert.deepEqual(matchSlashCommands('/n').map((command) => command.name), ['new']);
    assert.deepEqual(matchSlashCommands('/ed').map((command) => command.name), ['edit']);
    assert.deepEqual(matchSlashCommands('/e').map((command) => command.name), ['edit']);
    assert.deepEqual(matchSlashCommands('/rm').map((command) => command.name), ['delete']);
    assert.deepEqual(matchSlashCommands('/q').map((command) => command.name), ['quit']);
    assert.deepEqual(matchSlashCommands('/do').map((command) => command.name), ['folder']);
    assert.deepEqual(matchSlashCommands('new'), []);
    assert.deepEqual(matchSlashCommands('/new extra'), []);
    assert.deepEqual(matchSlashCommands('/help'), []);
  });

  it('lists connection commands above system commands', () => {
    const targets = [{ id: '1', name: 'prod', description: 'root@10.0.0.8:22' }];
    const open = matchSlashCommands('/', targets);
    assert.equal(open[0]?.group, 'connection');
    assert.equal(open[0]?.name, 'prod');
    assert.equal(open[0]?.connectionId, '1');
    assert.ok(open.slice(1).every((command) => command.group === 'command'));
    assert.deepEqual(matchSlashCommands('/prod', targets).map((command) => command.name), ['prod']);
    assert.equal(rawConnectionToken('My Server'), 'My-Server');
    assert.equal(isReservedCommand('new'), true);
    const mixed = matchSlashCommands('/edit', [{ id: '2', name: 'editor', description: 'lab' }]);
    assert.deepEqual(mixed.map((command) => command.name), ['editor', 'edit']);
    assert.equal(defaultSlashPick(mixed, '/edit'), 1);
  });

  it('finds connections by host, user or group as well as by name', () => {
    const targets = [
      { id: 'a', name: 'api', description: '', search: 'deploy@10.0.0.5:22 work' },
      { id: 'b', name: 'db', description: '', search: 'pg@db.internal:22 ' },
    ];
    assert.deepEqual(matchSlashCommands('/10.0.0', targets).map((item) => item.connectionId), ['a']);
    assert.deepEqual(matchSlashCommands('/pg@', targets).map((item) => item.connectionId), ['b']);
    assert.deepEqual(matchSlashCommands('/WORK', targets).map((item) => item.connectionId), ['a']);
    assert.equal(matchSlashCommands('/zzz', targets).length, 0);
    // A query that can still become a command does not search hosts.
    const editing = matchSlashCommands('/ed', [{ id: 'c', name: 'web', description: '', search: 'ed@web:22 ' }]);
    assert.deepEqual(editing.map((item) => item.name), ['edit']);
  });

  it('reads /run, /save, /forward and /unforward at the shell prompt, and nothing else', () => {
    assert.deepEqual(parseSessionCommand('/run'), { type: 'run' });
    assert.deepEqual(parseSessionCommand('  /save   tail -f log '), { type: 'save', command: 'tail -f log' });
    assert.deepEqual(parseSessionCommand('/save'), { type: 'save', command: '' });
    assert.deepEqual(parseSessionCommand('/forward 8080:3000'), { type: 'forward', spec: '8080:3000' });
    assert.deepEqual(parseSessionCommand('/forward'), { type: 'forward', spec: '' });
    assert.deepEqual(parseSessionCommand('/unforward 8080'), { type: 'unforward', port: '8080' });
    for (const line of ['/run x', '/runner', '/usr/bin/run', 'run', 'echo /save', '/Save x']) assert.equal(parseSessionCommand(line), undefined, line);
  });
});
