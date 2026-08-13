import { useEffect, useRef, useState } from 'react';

/**
 * Soft-keyboard tracking probe (owner-requested, 2026-08-13 — PROJECT.md §14).
 *
 * The chat composer moves in one discrete jump when the Android keyboard
 * opens, at the *end* of the IME animation, where iOS glides with it. Before
 * writing any more code against that, we need to know which signals — if any —
 * a given browser updates *during* the animation rather than only at its end.
 * Guessing the OS animation curve and driving the composer from a timer was
 * considered and rejected (owner: "don't force it and fight the browser"), so
 * this measures instead.
 *
 * What it does: focus the field below, and every animation frame for
 * `PROBE_MS` it records the four things a page can possibly learn the
 * keyboard's geometry from —
 *
 *   - `window.innerHeight`          (layout viewport; moves only under
 *                                    `interactive-widget=resizes-content`)
 *   - `visualViewport.height/offsetTop`  (what the iOS path already uses)
 *   - `env(keyboard-inset-height)`  (VirtualKeyboard API; needs
 *                                    `overlaysContent = true` to be non-zero)
 *   - `navigator.virtualKeyboard.boundingRect.height`
 *
 * — plus a timestamped log of which *events* fired (`resize`, `vv resize`,
 * `vv scroll`, `geometrychange`). The verdict per metric is just "how many
 * distinct values, spread over how long": several values over ~100ms+ means
 * that signal tracks the animation and the composer can be driven from it the
 * way iOS already is; one jump means the browser simply doesn't tell us until
 * it's over, and no amount of JS changes that.
 *
 * Both platform switches are toggleable here so all four combinations can be
 * measured on the real device without a redeploy: the viewport meta's
 * `interactive-widget` value (rewritten in place — browsers re-parse it) and
 * `navigator.virtualKeyboard.overlaysContent`. Both are restored on unmount;
 * neither persists.
 *
 * Note the sampler reads `offsetHeight` of a probe div each frame to get
 * `env(keyboard-inset-height)`, which forces a synchronous layout per frame.
 * That's acceptable for a measurement tool and is why this is a probe rather
 * than something the app ships in the hot path.
 */

const PROBE_MS = 1600;
/** A metric counts as tracking the animation if it changes in several steps
 *  spread over a stretch of time, rather than snapping once. */
const PROGRESSIVE_MIN_STEPS = 4;
const PROGRESSIVE_MIN_SPAN_MS = 80;

type Sample = {
  /** ms since focus/blur */
  t: number;
  inner: number;
  vv: number | null;
  vvTop: number | null;
  kbEnv: number;
  vk: number | null;
};

type Marker = { t: number; label: string };

type Capture = {
  phase: 'open' | 'close';
  ua: string;
  interactiveWidget: string;
  overlaysContent: boolean;
  samples: Sample[];
  markers: Marker[];
};

/** `navigator.virtualKeyboard` is Chromium-only and absent from lib.dom. */
interface VirtualKeyboardLike {
  overlaysContent: boolean;
  boundingRect: DOMRect;
  addEventListener(type: 'geometrychange', listener: () => void): void;
  removeEventListener(type: 'geometrychange', listener: () => void): void;
}

function virtualKeyboard(): VirtualKeyboardLike | null {
  return (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard ?? null;
}

function viewportMeta(): HTMLMetaElement | null {
  return document.querySelector('meta[name="viewport"]');
}

/** Rewrites just the `interactive-widget` key of the viewport meta, leaving
 *  every other key (notably `viewport-fit=cover`) alone. */
function setInteractiveWidget(mode: string) {
  const meta = viewportMeta();
  if (!meta) return;
  const keys = meta.content
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith('interactive-widget'));
  keys.push(`interactive-widget=${mode}`);
  meta.content = keys.join(', ');
}

function currentInteractiveWidget(): string {
  const meta = viewportMeta();
  const found = meta?.content.split(',').map((p) => p.trim()).find((p) => p.startsWith('interactive-widget='));
  return found?.split('=')[1] ?? '(unset)';
}

/** The frames where a metric's value differs from the frame before it. */
function transitions(samples: Sample[], pick: (s: Sample) => number | null): { t: number; value: number }[] {
  const out: { t: number; value: number }[] = [];
  let prev: number | null = null;
  for (const s of samples) {
    const value = pick(s);
    if (value === null) continue;
    if (prev !== null && value !== prev) out.push({ t: s.t, value });
    prev = value;
  }
  return out;
}

function verdict(steps: { t: number; value: number }[]): { text: string; good: boolean } {
  if (steps.length === 0) return { text: 'never changed', good: false };
  const span = steps[steps.length - 1]!.t - steps[0]!.t;
  const progressive = steps.length >= PROGRESSIVE_MIN_STEPS && span >= PROGRESSIVE_MIN_SPAN_MS;
  return {
    text: `${steps.length} step${steps.length === 1 ? '' : 's'}, ${steps[0]!.t}–${steps[steps.length - 1]!.t}ms`,
    good: progressive,
  };
}

export function KeyboardProbe() {
  // Both phases are kept side by side, not in one slot: blurring the field to
  // go read the result *is* the close capture, so a single slot means the open
  // capture — the one that matters — is always the one you can't see.
  const [captures, setCaptures] = useState<{ open: Capture | null; close: Capture | null }>({ open: null, close: null });
  const [status, setStatus] = useState('Focus the field to record.');
  const [overlays, setOverlays] = useState(false);
  const [widgetMode, setWidgetMode] = useState(currentInteractiveWidget);
  const envRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(false);

  const vk = virtualKeyboard();

  // Leave no trace: both switches are global page state, so whatever the probe
  // turned on gets turned back off when this section unmounts.
  useEffect(() => {
    const original = currentInteractiveWidget();
    return () => {
      setInteractiveWidget(original);
      const api = virtualKeyboard();
      if (api) api.overlaysContent = false;
    };
  }, []);

  function startCapture(phase: 'open' | 'close') {
    if (runningRef.current) return;
    runningRef.current = true;
    const t0 = performance.now();
    const samples: Sample[] = [];
    const markers: Marker[] = [];
    const mark = (label: string) => markers.push({ t: Math.round(performance.now() - t0), label });
    const vv = window.visualViewport;
    const api = virtualKeyboard();

    const onWinResize = () => mark(`window.resize inner=${window.innerHeight}`);
    const onVvResize = () => mark(`vv.resize h=${Math.round(vv?.height ?? 0)}`);
    const onVvScroll = () => mark(`vv.scroll top=${Math.round(vv?.offsetTop ?? 0)}`);
    const onGeometry = () => mark(`geometrychange h=${Math.round(api?.boundingRect.height ?? 0)}`);

    window.addEventListener('resize', onWinResize);
    vv?.addEventListener('resize', onVvResize);
    vv?.addEventListener('scroll', onVvScroll);
    api?.addEventListener('geometrychange', onGeometry);
    mark(phase === 'open' ? 'focus' : 'blur');

    const step = () => {
      const t = performance.now() - t0;
      samples.push({
        t: Math.round(t),
        inner: window.innerHeight,
        vv: vv ? Math.round(vv.height) : null,
        vvTop: vv ? Math.round(vv.offsetTop) : null,
        kbEnv: envRef.current?.offsetHeight ?? 0,
        vk: api ? Math.round(api.boundingRect.height) : null,
      });
      if (t < PROBE_MS) {
        requestAnimationFrame(step);
        return;
      }
      window.removeEventListener('resize', onWinResize);
      vv?.removeEventListener('resize', onVvResize);
      vv?.removeEventListener('scroll', onVvScroll);
      api?.removeEventListener('geometrychange', onGeometry);
      runningRef.current = false;
      const next: Capture = {
        phase,
        ua: navigator.userAgent,
        interactiveWidget: currentInteractiveWidget(),
        overlaysContent: api?.overlaysContent ?? false,
        samples,
        markers,
      };
      setCaptures((prev) => ({ ...prev, [phase]: next }));
      setStatus(`Captured ${samples.length} frames on ${phase}.`);
    };
    requestAnimationFrame(step);
    setStatus(`Recording ${phase}…`);
  }

  function rowsFor(capture: Capture) {
    return [
      ['window.innerHeight', transitions(capture.samples, (s) => s.inner)],
      ['visualViewport.height', transitions(capture.samples, (s) => s.vv)],
      ['visualViewport.offsetTop', transitions(capture.samples, (s) => s.vvTop)],
      ['env(keyboard-inset-height)', transitions(capture.samples, (s) => s.kbEnv)],
      ['virtualKeyboard.boundingRect', transitions(capture.samples, (s) => s.vk)],
    ] as const;
  }

  return (
    <section className="flex flex-col gap-2 text-sm">
      <h3 className="font-semibold">Keyboard probe</h3>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Focus the field, let the keyboard finish opening, then read the verdict. A metric marked{' '}
        <span className="text-green-600 dark:text-green-400">tracks</span> can drive the composer during the animation;{' '}
        <span className="text-amber-600 dark:text-amber-400">jumps</span> means the browser only reports it at the end.
      </p>

      {/* Zero-width, but its height is the live keyboard inset — the only way
          to read an env() value from JS. */}
      <div ref={envRef} aria-hidden style={{ width: 0, height: 'env(keyboard-inset-height, 0px)' }} />

      <label className="flex items-center justify-between gap-2 text-xs">
        <span>interactive-widget</span>
        <select
          value={widgetMode}
          onChange={(e) => {
            setWidgetMode(e.target.value);
            setInteractiveWidget(e.target.value);
          }}
          className="rounded border border-black/10 bg-white px-2 py-1 dark:border-white/10 dark:bg-neutral-800"
        >
          <option value="resizes-content">resizes-content</option>
          <option value="resizes-visual">resizes-visual</option>
          <option value="overlays-content">overlays-content</option>
        </select>
      </label>

      <label className="flex items-center justify-between gap-2 text-xs">
        <span>virtualKeyboard.overlaysContent {vk ? '' : '(unsupported here)'}</span>
        <input
          type="checkbox"
          disabled={!vk}
          checked={overlays}
          onChange={(e) => {
            setOverlays(e.target.checked);
            const api = virtualKeyboard();
            if (api) api.overlaysContent = e.target.checked;
          }}
        />
      </label>

      <input
        type="text"
        placeholder="Tap here to open the keyboard"
        onFocus={() => startCapture('open')}
        onBlur={() => startCapture('close')}
        className="rounded-md border border-black/10 bg-white px-3 py-2 dark:border-white/10 dark:bg-neutral-800"
      />

      <p className="text-xs text-neutral-500 dark:text-neutral-400">{status}</p>

      {(['open', 'close'] as const).map((phase) => {
        const capture = captures[phase];
        if (!capture) return null;
        return (
          <div key={phase} className="flex flex-col gap-1">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              {phase === 'open' ? 'Keyboard opening (focus)' : 'Keyboard closing (blur)'}
            </h4>
            <table className="w-full text-left text-xs">
              <tbody>
                {rowsFor(capture).map(([label, steps]) => {
                  const v = verdict(steps);
                  return (
                    <tr key={label} className="border-t border-black/5 dark:border-white/5">
                      <td className="py-1 pr-2 align-top font-mono">{label}</td>
                      <td className="py-1 pr-2 align-top">{v.text}</td>
                      <td
                        className={
                          'py-1 align-top font-semibold ' +
                          (v.good ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400')
                        }
                      >
                        {steps.length === 0 ? '—' : v.good ? 'tracks' : 'jumps'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      {(captures.open || captures.close) && (
        <>
          <button
            onClick={() => void navigator.clipboard?.writeText(JSON.stringify(captures)).then(() => setStatus('Copied.'))}
            className="self-start rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white"
          >
            Copy raw JSON (both phases)
          </button>

          {/* Readable without a desktop attached — the point of the probe is
              that the device can report its own findings. */}
          <textarea
            readOnly
            value={JSON.stringify(captures)}
            className="h-24 w-full rounded border border-black/10 bg-white p-2 font-mono text-[10px] dark:border-white/10 dark:bg-neutral-800"
          />
        </>
      )}
    </section>
  );
}
