import { InstallInstructions } from './components/InstallInstructions';
import { PushPoc } from './components/PushPoc';
import { VoicePoc } from './components/VoicePoc';
import { WsProbe } from './components/WsProbe';

/**
 * Stage 0 shell. This is a scaffolding/PoC surface, NOT the real app UI (the
 * IG-flavored tab bar + chat/gallery/profile of BACKBONE §9 arrive in later
 * stages). It exists to exercise the risk-retirement gates on real devices.
 *
 * Layout uses 100dvh + safe-area insets so it already "feels native" on iOS.
 */
export default function App() {
  return (
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div
        className="mx-auto flex max-w-lg flex-col gap-4 px-4 pb-10"
        style={{
          paddingTop: 'calc(env(safe-area-inset-top) + 1.5rem)',
          paddingLeft: 'max(env(safe-area-inset-left), 1rem)',
          paddingRight: 'max(env(safe-area-inset-right), 1rem)',
        }}
      >
        <header>
          <h1 className="text-2xl font-bold tracking-tight">Den</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Stage 0 · risk-retirement PoCs · den.ems-place.com
          </p>
        </header>

        <InstallInstructions />
        <PushPoc />
        <VoicePoc />
        <WsProbe />

        <footer className="pt-2 text-center text-xs text-neutral-400">
          Not the real UI — validating push, voice, and realtime on real devices.
        </footer>
      </div>
    </div>
  );
}
