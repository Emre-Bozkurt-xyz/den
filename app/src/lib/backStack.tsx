import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';

/**
 * Bridges Den's hand-rolled navigation + overlays to the browser History API
 * so the Android / iOS system back gesture pops one *app* layer at a time
 * instead of unwinding out of the SPA to a blank page.
 *
 * Den has no router — navigation is a single `view` state (App.tsx) and
 * overlays (MediaViewer, the message focus menu, selection mode) are local
 * component state. None of it was ever reflected in browser history, so in an
 * installed PWA (whose history starts empty) a back gesture had nowhere to go
 * but a blank document.
 *
 * Model — the classic PWA "single trap, always re-armed":
 *   - Exactly ONE history entry (a "trap") is kept on top at all times: pushed
 *     once on mount, and re-pushed on *every* popstate. So a back press always
 *     pops the trap (staying inside the app), and we immediately restore it for
 *     the next press. The user can never fall out of the PWA to a blank page.
 *   - Active layers register a handler via `useBackHandler`, forming a LIFO
 *     stack. On each back press we pop the *topmost* handler and call it (close
 *     overlay / cancel selection / navigate up one view). Overlays register
 *     after the view they sit on, so LIFO closes the overlay first, then unwinds
 *     the view stack.
 *   - At the root (no handlers) a back press does nothing but re-arm the trap —
 *     a safe no-op, never blank, never an exit. (App.tsx routes non-home root
 *     tabs back to Chats first, so only the Chats home tab has an inert back.)
 *
 * Deliberately does NOT try to mirror app *depth* into history (one entry per
 * layer): that requires reconciling entry counts with programmatic
 * `history.back()`, whose bookkeeping drifts on lateral deep→deep moves (e.g.
 * chat → that chat's gallery → gallery) and can strand the buffer so a later
 * root back escapes to a blank page. Re-arming a single trap on every pop has
 * no such state to get wrong. Cost: the browser forward button is inert and
 * back never exits the app — both irrelevant in a standalone PWA.
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
  // layer — the one a back press closes. Registration alone touches no history;
  // the single trap is managed entirely by the mount effect below.
  const handlersRef = useRef<Handler[]>([]);

  useEffect(() => {
    // Arm the trap: one extra entry so the first back press is caught.
    window.history.pushState({ den: 'back-trap' }, '');

    const onPop = () => {
      // The trap was just consumed by the back press. Pop one app layer if any,
      // then re-arm so the next back press is caught too. Order matters only in
      // that we re-arm unconditionally — even a root back with no handler must
      // restore the trap, or the following back would escape to a blank page.
      const top = handlersRef.current[handlersRef.current.length - 1];
      if (top) top.onBack();
      window.history.pushState({ den: 'back-trap' }, '');
    };

    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const api = useMemo<BackStackApi>(
    () => ({
      register(id, onBack) {
        handlersRef.current = [...handlersRef.current.filter((h) => h.id !== id), { id, onBack }];
      },
      unregister(id) {
        handlersRef.current = handlersRef.current.filter((h) => h.id !== id);
      },
    }),
    [],
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
