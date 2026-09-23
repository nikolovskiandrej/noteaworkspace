/** The terminal in the workspace palette: the canvas behind, mint cursor, muted ANSI colours. */
export const TERMINAL_THEME = {
  background: '#090b0a',
  foreground: '#d9dcd3',
  cursor: '#7cc4a0',
  cursorAccent: '#090b0a',
  selectionBackground: 'rgba(124, 196, 160, 0.26)',
  black: '#1a1f1c',
  red: '#ec7c73',
  green: '#7cc4a0',
  yellow: '#dcae5a',
  blue: '#8fb4e6',
  magenta: '#ad9df3',
  cyan: '#7fc2c2',
  white: '#d9dcd3',
  brightBlack: '#5b635d',
  brightRed: '#f29a92',
  brightGreen: '#9ed8b9',
  brightYellow: '#e8c47e',
  brightBlue: '#abc8ef',
  brightMagenta: '#c5b9f7',
  brightCyan: '#a0d8d8',
  brightWhite: '#f4f5ef',
};

export const TERMINAL_FONT_FAMILY = '"IBM Plex Mono", ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace';

/**
 * xterm measures its character cell once, when it opens, so it has to measure the
 * font it will draw with. Waits for the self-hosted mono font (at most 1.5 s, then
 * carries on with whatever is available).
 */
export async function monoFontReady(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  try {
    await Promise.race([
      Promise.all([document.fonts.load('13px "IBM Plex Mono"'), document.fonts.load('600 13px "IBM Plex Mono"')]),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // A font that fails to load is not a reason to have no terminal.
  }
}
