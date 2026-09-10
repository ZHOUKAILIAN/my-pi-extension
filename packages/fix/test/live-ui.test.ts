import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveWorkerEditor, renderWorkerText } from '../src/extension-v2.ts';
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';

test('Worker renderer uses Pi width semantics for CJK and newlines', () => {
  const rendered = renderWorkerText('中文\nalpha beta', 6);
  const lines = rendered.split('\n');
  assert.deepEqual(lines, ['中文', 'alpha', 'beta']);
  assert.ok(lines.every((line) => visibleWidth(line) <= 6));
});

test('Pi 0.84.2 CustomEditor contract delegates the previous editor and fences model keys', () => {
  const calls: string[] = [];
  const active = { value: true };
  const historyKey = String.fromCharCode(0x1b) + '[A';
  const keybindings = { matches: (data: string, action: string) => data === 'model' && action === 'app.model.select'
    || data === historyKey && (action === 'tui.editor.historyPrevious' || action === 'app.model.select')
    || data === 'extension' && action === 'extension.test' };
  const tui = { requestRender: () => {} };
  const theme = { borderColor: 'white' };
  const previousFactory = (innerTui: any, innerTheme: any, innerBindings: any) => new CustomEditor(innerTui, innerTheme, innerBindings);
  const editor = new LiveWorkerEditor(tui, theme, keybindings, previousFactory, {
    active: () => active.value,
    select: () => { calls.push('model'); },
    cycle: () => { calls.push('cycle'); },
  });
  editor.setText('keep this text');
  editor.addToHistory('first command');
  editor.onExtensionShortcut = (data) => data === 'extension';
  editor.onAction('tui.editor.historyPrevious', () => { calls.push('history-action'); });
  editor.handleInput('model');
  editor.handleInput(historyKey);
  editor.handleInput('extension');
  assert.equal(editor.getText(), 'keep this text');
  assert.deepEqual(calls, ['model']);
  active.value = false;
  editor.handleInput('model');
  assert.equal(editor.getText(), 'modelkeep this text');
});
