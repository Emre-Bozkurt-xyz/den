import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';

/**
 * Bridges Den's hand-rolled navigation + overlays to the browser History API
 * so the Android / iOS system back gesture pops one *app* layer at a time
 * instead of unwinding out of the SPA to a blank page.
 *
 * Den has no router — navigation is a single `view` state (App.tsx) and
 * overlays (MediaViewer, the message focus menu) are local component state.
 * None of it was ever reflected in browser history, so in an installed PWA
 * (whose history starts empty) a back gesture had nowhere to go but a blank
 * document.
 *
 * Model — a LIFO stack of back handlers, mirrored into history:
 *   - A **base guard** entry is pushed once on mount and sits beneath every
 *     layer. A back press at the true root pops it, we re-arm it, and the user
 *     never leaves the PWA — so root back is a safe no-op, never a blank page.
 *     (App.tsx makes non-home root tabs back to Chats first, so only the Chats
 *     home tab has an inert back.)
 *   - Each active layer (a deep view, an open overlay) registers a handler via
 *     `useBackHandler`, which keeps one "trap" history entry per layer.
 *   - System back press → we pop the topmost handler and call it (close overlay
 *     / navigate up). Because overlays register *after* the view they sit on,
 *     LIFO closes the overlay first, then unwinds the view stack.
 *   - Closing a layer via an in-app control (tap X, backdrop, a tab) instead
 *     leaves a stale trap; the reconcile step consumes it with a guarded
 *     programmatic `history.back()` so the next real back press isn't eaten.
 *
 * iOS note (CLAUDE.md platform reality): in a standalone installed PWA the only
 * back affordance is the screen-edge swipe; Safari standalone fires `popstate`
 * for it, so this works — but it belongs on the iOS-device testing checklist
 * for the stage gate since we don't dev on iOS.
 */

type Handler = { id: symbol; onBack: () => void };

type BackStackApi = {
  register: (id: symbol, onBack: () => void) => void;
  unregister: (id: symbol) => void;
};

const BackStackContext = createContext<BackStackApi | null>(null);

export function BackStackProvider({ children }: { children: ReactNode }) {
  // Active back handlers, shallowest first. The last element is the topmost
  // layer — the one a back press closes.
  const handlersRef = useRef<Handler[]>([]);
  // How many trap entries we believe are in history above the base guard.
  // Target invariant after every reconcile: === handlersRef.current.length.
  const trapCountRef = useRef(0);
  // Count of programmatic history.back() calls whose popstate we must swallow
  // (they're us consuming a stale trap, not the user pressing back).
  const ignorePopsRef = useRef(0);

  const reconcile = useCallback(() => {
    const want = handlersRef.current.length;
    // Adding traps (multiple pushState calls are safe to batch).
    while (trapCountRef.current < want) {
      window.history.pushState({ den: 'back-trap' }, '');
      trapCountRef.current += 1;
    }
    // Removing stale traps. In practice layers open/close one at a time, so
    // this steps once; the guarded history.back() re-runs reconcile-free.
    while (trapCountRef.current > want) {
      ignorePopsRef.current += 1;
      trapCountRef.current -= 1;
      window.history.back();
    }
  }, []);

  useEffect(() => {
    // Base guard: one entry beneath every layer so a back press at the true
    // root is caught and re-armed rather than falling out of the PWA.
    window.history.pushState({ den: 'back-guard' }, '');

    const onPop = () => {
      if (ignorePopsRef.current > 0) {
        ignorePopsRef.current -= 1;
        return;
      }
      if (trapCountRef.current > 0) {
        // The user popped a trap layer — close the topmost one. The browser
        // already removed the history entry, so drop our count to match; the
        // handler's own unregister (fired when it closes) then finds nothing
        // stale to consume.
        trapCountRef.current -= 1;
        const top = handlersRef.current[handlersRef.current.length - 1];
        if (top) top.onBack();
      } else {
        // Base guard popped at the true root — re-arm and stay in the app.
        window.history.pushState({ den: 'back-guard' }, '');
      }
    };

    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const api = useMemo<BackStackApi>(
    () => ({
      register(id, onBack) {
        handlersRef.current = [...handlersRef.current.filter((h) => h.id !== id), { id, onBack }];
        reconcile();
      },
      unregister(id) {
        handlersRef.current = handlersRef.current.filter((h) => h.id !== id);
        reconcile();
      },
    }),
    [reconcile],
  );

  return <BackStackContext.Provider value={api}>{children}</BackStackContext.Provider>;
}

/**
 * Registers a back-intercept layer while `active` is true. A system back press
 * (or browser back button) closes the topmost active layer by calling `onBack`
 * instead of navigating the document. `onBack` is always read fresh, so its
 * closure may safely capture changing state without re-registering.
 *
 * Typical use: `useBackHandler(true, onClose)` inside an overlay that only
 * mounts while open, or `useBackHandler(isDeep, () => navigateUp())` for a
 * view that should intercept back only at certain depths.
 */
export function useBackHandler(active: boolean, onBack: () => void) {
  const api = useContext(BackStackContext);
  const idRef = useRef<symbol>(Symbol('back-handler'));
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!api || !active) return;
    const id = idRef.current;
    api.register(id, () => onBackRef.current());
    return () => api.unregister(id);
  }, [api, active]);
}
