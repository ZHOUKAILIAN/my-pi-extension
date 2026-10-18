import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

type Theme = Parameters<NonNullable<ToolRenderers["renderCall"]>>[1];
type RendererContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

const wrappers = new WeakMap<Component, ForegroundComponent>();

class ForegroundComponent implements Component {
  private inner: Component;
  private theme: Theme;

  constructor(inner: Component, theme: Theme) {
    this.inner = inner;
    this.theme = theme;
    if (inner.handleInput) {
      Object.defineProperty(this, "handleInput", {
        configurable: true,
        enumerable: true,
        value: (data: string) => inner.handleInput!.call(inner, data),
      });
    }
    if (inner.handleMouse) {
      Object.defineProperty(this, "handleMouse", {
        configurable: true,
        enumerable: true,
        value: (event: Parameters<NonNullable<Component["handleMouse"]>>[0]) => inner.handleMouse!.call(inner, event),
      });
    }
    if ("wantsKeyRelease" in inner) {
      Object.defineProperty(this, "wantsKeyRelease", {
        configurable: true,
        enumerable: true,
        get: () => inner.wantsKeyRelease,
        set: (value: boolean) => { inner.wantsKeyRelease = value; },
      });
    }
    if ("focused" in inner) {
      Object.defineProperty(this, "focused", {
        configurable: true,
        enumerable: true,
        get: () => (inner as Component & { focused: boolean }).focused,
        set: (value: boolean) => { (inner as Component & { focused: boolean }).focused = value; },
      });
    }
  }

  innerComponent(): Component { return this.inner; }
  setTheme(theme: Theme): void { this.theme = theme; }

  render(width: number): string[] {
    return this.inner.render(width).map((line) => applyTextForeground(line, this.theme));
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}

/** Adds the theme's text foreground only to uncolored spans and closes it per line. */
export function applyTextForeground(line: string, theme: Theme): string {
  if (!line) return line;
  const foreground = theme.getFgAnsi("text");
  let output = "";
  let hasForeground = false;
  let index = 0;

  while (index < line.length) {
    if (line[index] !== "\x1b") {
      const nextEscape = line.indexOf("\x1b", index);
      const end = nextEscape === -1 ? line.length : nextEscape;
      const text = line.slice(index, end);
      if (text && !hasForeground) output += foreground;
      output += text;
      index = end;
      continue;
    }

    const escape = readEscapeSequence(line, index);
    if (!escape) {
      output += line[index++];
      continue;
    }
    output += escape;
    if (escape.startsWith("\x1b[") && escape.endsWith("m")) {
      hasForeground = updateForegroundState(escape.slice(2, -1), hasForeground);
    }
    index += escape.length;
  }

  // Close only foreground; backgrounds and text attributes are left untouched.
  return `${output}\x1b[39m`;
}

/** Reads only the ANSI forms used by renderer output, including OSC 8 BEL/ST links. */
function readEscapeSequence(value: string, start: number): string | undefined {
  if (value[start] !== "\x1b" || start + 1 >= value.length) return undefined;
  const kind = value[start + 1];
  if (kind === "[" || kind === "]" || kind === "_") {
    for (let i = start + 2; i < value.length; i++) {
      if (kind === "[" && value.charCodeAt(i) >= 0x40 && value.charCodeAt(i) <= 0x7e) return value.slice(start, i + 1);
      if ((kind === "]" || kind === "_") && value[i] === "\x07") return value.slice(start, i + 1);
      if ((kind === "]" || kind === "_") && value[i] === "\x1b" && value[i + 1] === "\\") return value.slice(start, i + 2);
    }
    return undefined;
  }
  return value.slice(start, start + 2);
}

/** Processes SGR parameters without treating extended-color payloads as SGR codes. */
function updateForegroundState(parameters: string, initial: boolean): boolean {
  let hasForeground = initial;
  const groups = parameters.split(";");
  for (let i = 0; i < groups.length; i++) {
    const fields = groups[i].split(":");
    const code = Number(fields[0]);

    if (fields.length > 1) {
      if (code === 0 || code === 39) hasForeground = false;
      else if (code === 38) hasForeground = true;
      continue;
    }

    if (code === 0 || code === 39) hasForeground = false;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97) || code === 38) hasForeground = true;

    if ((code === 38 || code === 48 || code === 58) && groups[i + 1] !== undefined) {
      const mode = Number(groups[i + 1].split(":")[0]);
      if (mode === 5) i += 2;
      else if (mode === 2) i += 4;
    }
  }
  return hasForeground;
}

function wrapped(component: Component, theme: Theme): Component {
  const existing = wrappers.get(component);
  if (existing) {
    existing.setTheme(theme);
    return existing;
  }
  const result = new ForegroundComponent(component, theme);
  wrappers.set(component, result);
  return result;
}

// Renderer state is owned by the host renderer. Unwrap only our display adapter
// before passing the call/result through, so cached Text/Container instances remain valid.
function adapt(renderer: ToolRenderers | undefined): ToolRenderers | undefined {
  if (!renderer) return undefined;
  return {
    renderShell: renderer.renderShell,
    renderCall: renderer.renderCall && ((args, theme, context) => {
      const innerContext = { ...context, lastComponent: unwrap(context.lastComponent) } as RendererContext;
      return wrapped(renderer.renderCall!(args, theme, innerContext), theme);
    }),
    renderResult: renderer.renderResult && ((result, options, theme, context) => {
      const innerContext = { ...context, lastComponent: unwrap(context.lastComponent) } as RendererContext;
      return wrapped(renderer.renderResult!(result, options, theme, innerContext), theme);
    }),
  };
}

function unwrap(component: Component | undefined): Component | undefined {
  return component instanceof ForegroundComponent ? component.innerComponent() : component;
}

export default function (pi: ExtensionAPI): void {
  pi.registerToolRenderer((toolName, next) => {
    if (toolName !== "read" && toolName !== "write") return next();
    return adapt(next());
  });
}
