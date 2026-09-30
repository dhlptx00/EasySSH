import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyDrop, splitShellTokens } from './shellTokens';

describe('dropped paths', () => {
  it('splits quoted shell tokens', () => {
    assert.deepEqual(splitShellTokens(`'/tmp/my file.txt' /tmp/a.txt`), ['/tmp/my file.txt', '/tmp/a.txt']);
  });

  it('accepts a drop only when every path exists', () => {
    const files = new Set(['/tmp/a.txt', '/tmp/my file.txt']);
    assert.deepEqual(
      classifyDrop(`'/tmp/my file.txt' /tmp/a.txt`, (file) => files.has(file), '/Users/me'),
      ['/tmp/my file.txt', '/tmp/a.txt'],
    );
    assert.equal(classifyDrop('/tmp/missing', (file) => files.has(file), '/Users/me'), null);
    assert.equal(classifyDrop('/', () => true, '/Users/me'), null);
    assert.deepEqual(
      classifyDrop('file:///tmp/a.txt', (file) => files.has(file), '/Users/me'),
      ['/tmp/a.txt'],
    );
    assert.deepEqual(
      classifyDrop('/tmp/my file.txt', (file) => files.has(file), '/Users/me'),
      ['/tmp/my file.txt'],
    );
  });

  it('accepts the forms Windows drops arrive in', () => {
    const exists = () => true;
    // VS Code sends an extension terminal the path with / instead of \.
    assert.deepEqual(classifyDrop('C:/Users/me/Desktop/捕获.PNG', exists, 'C:\\Users\\me'), ['C:/Users/me/Desktop/捕获.PNG']);
    assert.deepEqual(classifyDrop('C:\\Users\\me\\my file (1).txt', exists, 'C:\\Users\\me'), ['C:\\Users\\me\\my file (1).txt']);
    assert.deepEqual(classifyDrop('//fs01/home$/me/Desktop/a.txt', exists, 'C:\\Users\\me'), ['//fs01/home$/me/Desktop/a.txt']);
    assert.deepEqual(classifyDrop('\\\\fs01\\home$\\me\\a.txt', exists, 'C:\\Users\\me'), ['\\\\fs01\\home$\\me\\a.txt']);
  });
});
