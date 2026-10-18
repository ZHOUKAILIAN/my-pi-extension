# @pi/tool-text-contrast

Independent Pi package that improves foreground contrast in the built-in `read` and `write` tool renderers. It uses Pi's public `registerToolRenderer()` API and applies the active theme's text foreground only to output spans without an explicit foreground. Tool execution, inputs, and results are unchanged.

Load locally for one invocation with `pi -e ./packages/tool-text-contrast`, or install the package through Pi package management. The peer range is Pi `>=1.0.4 <1.2.0`; development dependencies target `1.1.0`.
