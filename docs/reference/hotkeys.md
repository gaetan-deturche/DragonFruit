# Hotkey System Specification

Centralized Zustand state store controls all key bindings.

## Architecture

- **Store**: `src/hotkeys/hotkeyStore.ts`
- **Config**: `src/hotkeys/hotkeyConfig.ts`
- **Listener Manager**: `src/hotkeys/HotkeyRegistryManager.tsx`

## Developer Rules

1. **No direct listeners**: Never use `window.addEventListener('keydown' | 'keyup')` or `element.onkeydown`.
2. **Hook usage**: React components read key state via `useActionActive(category, action)`.
3. **Sync lookup**: Performance-critical loops (e.g. Three.js render frame) read key state via `isKeyPressedSync(key)`.
4. **Modifying bindings**: Update `DEFAULT_KEYBINDINGS` in `hotkeyConfig.ts`.
5. **Toggles fire on the press edge**: `useActionActive` reports the binding as HELD, not
   as pressed. A toggle must compare against the previous value (see
   `useInteriorViewHotkey`, `useOrganicCutPreviewHotkey`) or it re-fires for as long as
   the key is down.

## API Reference

### `useActionActive(category: string, actionName: string): boolean`
React hook. Reactive to modifier changes. Excludes overlapping modifiers.

### `isKeyPressedSync(key: string): boolean`
Non-reactive getter. Direct Set lookup. Use in high-frequency requestAnimationFrame loops.
