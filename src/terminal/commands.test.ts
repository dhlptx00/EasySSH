import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultSlashPick, isReservedCommand, matchSlashCommands, parseConnectionCommand, rawConnectionToken } from './commands';

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
});
