import assert from "node:assert/strict";
import test from "node:test";
import { extractAnsiCode, stripTerminalSequences, visibleWidth } from "../node_modules/@earendil-works/pi-tui/dist/utils.js";
import { readRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/read.js";
import { writeRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/write.js";
import { getThemeByName, setThemeInstance } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import extension, { applyTextForeground } from "../src/index.ts";

const themes = { light: getThemeByName("light")!, dark: getThemeByName("dark")! };

let resolver: ((name: string, next: () => any) => any) | undefined;
extension({ registerToolRenderer: (value: typeof resolver) => { resolver = value; } } as never);
assert.ok(resolver);
const read = resolver("read", () => readRenderers)!;
const write = resolver("write", () => writeRenderers)!;

function context(args: any, overrides: Record<string, unknown> = {}): any {
  return {
    args,
    toolCallId: "test-call",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 0,
    ...overrides,
  };
}

function lineContaining(lines: string[], visibleText: string): string {
  const line = lines.find((candidate) => stripTerminalSequences(candidate).includes(visibleText));
  assert.ok(line, `missing visible text: ${visibleText}`);
  return line;
}

function assertPlainTsContrast(rawLines: string[], wrappedLines: string[], theme: any): string {
  const raw = lineContaining(rawLines, "plainIdentifier");
  const decorated = lineContaining(wrappedLines, "plainIdentifier");
  const keyword = theme.getFgAnsi("syntaxKeyword");
  const number = theme.getFgAnsi("syntaxNumber");
  const text = theme.getFgAnsi("text");
  const rawSegment = `${keyword}const\x1b[39m plainIdentifier = ${number}1\x1b[39m;`;
  const decoratedSegment = `${keyword}const\x1b[39m${text} plainIdentifier = ${number}1\x1b[39m${text};`;

  assert.ok(raw.includes(rawSegment), "baseline plainIdentifier must have no foreground between keyword and number styles");
  assert.ok(!raw.includes(`${text}plainIdentifier`), "baseline renderer unexpectedly colored the target with theme text");
  assert.ok(decorated.includes(decoratedSegment), "wrapped renderer must apply theme.text exactly to the uncolored identifier");
  const textColorStart = decorated.indexOf(text);
  return decorated.slice(textColorStart, textColorStart + text.length);
}

function rendered(component: any, width = 80): string[] {
  return component.render(width);
}

test("scanner handles SGR 0/39, semicolon and colon 38/48/58 colors, and both OSC 8 terminators", () => {
  const original = "\x1b[48;2;31;0;39m中文 \x1b[58;5;39munderline \x1b[38:2::12:34:56mcolor\x1b[39mplain";
  const output = applyTextForeground(original, themes.light);
  const textFg = themes.light.getFgAnsi("text");
  assert.ok(output.includes(`\x1b[48;2;31;0;39m${textFg}中文`));
  assert.ok(output.includes(`\x1b[58;5;39m${textFg}underline`));
  assert.ok(output.includes("\x1b[38:2::12:34:56mcolor\x1b[39m"));
  assert.ok(output.includes(`${textFg}plain`));
  const resetInput = "\x1b[31mred\x1b[0mplain\x1b[39mdefault";
  const resetOutput = applyTextForeground(resetInput, themes.light);
  assert.ok(resetOutput.includes("\x1b[31mred\x1b[0m"));
  assert.ok(resetOutput.includes(`${textFg}plain`));
  assert.ok(resetOutput.includes(`${textFg}default`));
  assert.ok(output.endsWith("\x1b[39m"));
  assert.equal(visibleWidth(output), visibleWidth(original));

  for (const terminator of ["\x07", "\x1b\\"]) {
    const linkedPlain = `\x1b]8;;https://example.test${terminator}中文链接\x1b]8;;${terminator}`;
    const linkedColored = `\x1b]8;;https://example.test${terminator}\x1b[38;5;196mred\x1b[39mplain\x1b]8;;${terminator}`;
    const plainOutput = applyTextForeground(linkedPlain, themes.light);
    const coloredOutput = applyTextForeground(linkedColored, themes.light);
    assert.ok(plainOutput.includes(`${terminator}${textFg}中文链接\x1b]8;;${terminator}`));
    assert.ok(coloredOutput.includes(`\x1b[38;5;196mred\x1b[39m${textFg}plain`));
    assert.equal(visibleWidth(plainOutput), visibleWidth(linkedPlain));
  }
});

test("real built-in write renderer preserves Markdown/highlight output, streams args, cache, theme changes, and narrow layout", () => {
  const args = { path: "contrast.md", content: "中文标题\n\nplain markdown paragraph\n\n- item\n\n```ts\nconst answer: number = 42;\n```" };
  setThemeInstance(themes.light);
  const rawFirst = writeRenderers.renderCall!(args, themes.light, context(args, { argsComplete: false, isPartial: true }));
  const firstContext = context(args, { argsComplete: false, isPartial: true });
  const first = write.renderCall!(args, themes.light, firstContext);
  const firstLines = rendered(first, 18);
  assert.deepEqual(firstLines.map(stripTerminalSequences), rendered(rawFirst, 18).map(stripTerminalSequences));
  const visible = firstLines.map(stripTerminalSequences).join("\n");
  assert.ok(visible.includes("中文标题"));
  assert.ok(visible.includes("plain") && visible.includes("paragraph"));
  assert.ok(visible.includes("const") && visible.includes("answer"));
  assert.ok(firstLines.some((line) => visibleWidth(line) <= 18));

  const streamedArgs = { ...args, content: `${args.content}\n// streamed 中文` };
  const streamContext = context(streamedArgs, { argsComplete: false, isPartial: true, lastComponent: first });
  const streamed = write.renderCall!(streamedArgs, themes.light, streamContext);
  assert.equal(streamed, first);
  assert.ok(rendered(streamed, 80).map(stripTerminalSequences).join("\n").includes("streamed 中文"));

  setThemeInstance(themes.dark);
  const themeContext = context(streamedArgs, { argsComplete: true, lastComponent: streamed });
  const themed = write.renderCall!(streamedArgs, themes.dark, themeContext);
  const darkLines = rendered(themed, 80);
  const darkRaw = writeRenderers.renderCall!(streamedArgs, themes.dark, context(streamedArgs, { argsComplete: true }));
  assert.deepEqual(darkLines.map(stripTerminalSequences), rendered(darkRaw, 80).map(stripTerminalSequences));
});

test("read/write plain.ts fallback matches both theme text colors while neighboring syntax colors stay unchanged", () => {
  const snapshots: Record<string, { write: string; read: string }> = {};
  const args = { path: "plain.ts", content: "const plainIdentifier = 1;" };

  for (const [name, theme] of Object.entries(themes)) {
    setThemeInstance(theme);
    const rawWrite = writeRenderers.renderCall!(args, theme, context(args));
    const fixedWrite = write.renderCall!(args, theme, context(args));
    const rawWriteLines = rendered(rawWrite, 120);
    const fixedWriteLines = rendered(fixedWrite, 120);
    assert.deepEqual(fixedWriteLines.map(stripTerminalSequences), rawWriteLines.map(stripTerminalSequences));
    const writeForeground = assertPlainTsContrast(rawWriteLines, fixedWriteLines, theme);

    const result = { content: [{ type: "text", text: args.content }], details: undefined };
    const resultOptions = { expanded: true, isPartial: false };
    const rawRead = readRenderers.renderResult!(result, resultOptions, theme, context(args));
    const fixedRead = read.renderResult!(result, resultOptions, theme, context(args));
    const rawReadLines = rendered(rawRead, 120);
    const fixedReadLines = rendered(fixedRead, 120);
    assert.deepEqual(fixedReadLines.map(stripTerminalSequences), rawReadLines.map(stripTerminalSequences));
    const readForeground = assertPlainTsContrast(rawReadLines, fixedReadLines, theme);

    snapshots[name] = { write: writeForeground, read: readForeground };
  }

  assert.notEqual(snapshots.light.write, snapshots.dark.write, "write snapshots must contain distinct light/dark text foregrounds");
  assert.notEqual(snapshots.light.read, snapshots.dark.read, "read snapshots must contain distinct light/dark text foregrounds");
});

test("real built-in read/write result renderers cover success, error, empty, and image results without changing content", () => {
  setThemeInstance(themes.light);
  const readArgs = { path: "sample.md" };
  const base = context(readArgs, { argsComplete: true, expanded: true });
  const readCall = read.renderCall!(readArgs, themes.light, base);
  const readOk = read.renderResult!({ content: [{ type: "text", text: "中文 read markdown" }], details: undefined }, { expanded: true, isPartial: false }, themes.light, context(readArgs));
  const readUpdated = read.renderResult!({ content: [{ type: "text", text: "中文 read markdown updated" }], details: undefined }, { expanded: true, isPartial: true }, themes.dark, context(readArgs, { lastComponent: readOk, isPartial: true }));
  assert.equal(readUpdated, readOk);
  const readLines = rendered(readUpdated, 24);
  assert.ok(readLines.map(stripTerminalSequences).join("\n").includes("中文 read markdown"));
  assert.ok(readCall);

  const readError = read.renderResult!({ content: [{ type: "text", text: "read failed" }], details: undefined }, { expanded: false, isPartial: false }, themes.light, context(readArgs, { isError: true }));
  assert.ok(rendered(readError).map(stripTerminalSequences).join("\n").includes("read failed"));
  const emptyRead = read.renderResult!({ content: [], details: undefined }, { expanded: true, isPartial: false }, themes.light, context(readArgs));
  assert.equal(stripTerminalSequences(rendered(emptyRead).join("\n")).trim(), "");
  const imageResult = read.renderResult!({ content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], details: undefined }, { expanded: true, isPartial: false }, themes.light, context(readArgs, { showImages: false }));
  assert.ok(rendered(imageResult).map(stripTerminalSequences).join("\n").includes("image/png"));

  const writeArgs = { path: "sample.md", content: "write content" };
  const writeCall = write.renderCall!(writeArgs, themes.light, context(writeArgs));
  const writeSuccess = write.renderResult!({ content: [{ type: "text", text: "success" }], details: undefined }, { expanded: false, isPartial: false }, themes.light, context(writeArgs));
  assert.equal(rendered(writeSuccess).length, 0);
  const writeError = write.renderResult!({ content: [{ type: "text", text: "write failed" }], details: undefined }, { expanded: false, isPartial: false }, themes.light, context(writeArgs, { isError: true }));
  const updatedError = write.renderResult!({ content: [{ type: "text", text: "write failed again" }], details: undefined }, { expanded: false, isPartial: true }, themes.dark, context(writeArgs, { isError: true, isPartial: true, lastComponent: writeError }));
  assert.equal(updatedError, writeError);
  assert.ok(rendered(updatedError).map(stripTerminalSequences).join("\n").includes("write failed again"));
  const empty = write.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, themes.light, context(writeArgs));
  assert.equal(rendered(empty).length, 0);
  assert.ok(writeCall);
});

test("non-target renderers pass through; custom component input, mouse, focus, invalidate, and cache are delegated", () => {
  const otherRenderer = { renderCall: () => ({ render: () => ["unchanged"], invalidate() {} }) };
  assert.equal(resolver!("bash", () => otherRenderer), otherRenderer);

  let invalidations = 0;
  const mouseEvent = { type: "wheel", deltaY: 1 } as any;
  const mouseResult = { handled: true } as any;
  let inputValue: string | undefined;
  let receivedMouse: unknown;
  const component: any = {
    focused: false,
    wantsKeyRelease: true,
    render: () => ["plain"],
    handleInput(this: unknown, data: string) { assert.equal(this, component); inputValue = data; },
    handleMouse(this: unknown, event: unknown) { assert.equal(this, component); receivedMouse = event; return mouseResult; },
    invalidate() { invalidations++; },
  };
  let calls = 0;
  const custom = resolver!("write", () => ({ renderCall: (_args: unknown, _theme: unknown, ctx: any) => {
    assert.equal(ctx.lastComponent, calls++ === 0 ? undefined : component);
    return component;
  } }));
  const initial = custom.renderCall!({}, themes.light, context({}, { lastComponent: undefined }));
  assert.equal(initial.render(80)[0], `${themes.light.getFgAnsi("text")}plain\x1b[39m`);
  initial.handleInput!("key-data");
  assert.equal(inputValue, "key-data");
  assert.equal(initial.handleMouse!(mouseEvent), mouseResult);
  assert.equal(receivedMouse, mouseEvent);
  assert.equal(initial.wantsKeyRelease, true);
  initial.wantsKeyRelease = false;
  assert.equal(component.wantsKeyRelease, false);
  assert.equal(initial.focused, false);
  initial.focused = true;
  assert.equal(component.focused, true);
  component.focused = false;
  assert.equal(initial.focused, false);

  const reused = custom.renderCall!({}, themes.dark, context({}, { lastComponent: initial }));
  assert.equal(reused, initial);
  reused.invalidate();
  assert.equal(invalidations, 1);
  assert.ok(reused.render(80)[0].includes(themes.dark.getFgAnsi("text")));

  const nonFocusableComponent = { render: () => ["plain"], invalidate() {} };
  const nonFocusableRenderer = resolver!("read", () => ({ renderCall: () => nonFocusableComponent }));
  const nonFocusable = nonFocusableRenderer.renderCall!({}, themes.light, context({}));
  assert.equal("focused" in nonFocusable, false);
  assert.equal("handleInput" in nonFocusable, false);
  assert.equal("handleMouse" in nonFocusable, false);
  assert.equal("wantsKeyRelease" in nonFocusable, false);
});
