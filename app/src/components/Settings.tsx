import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@den/shared';
import { updateMe } from '../lib/auth';
import { VaultLinkSection } from './Profile';
import { NotificationsSection, PushPoc } from './PushPoc';
import { VoicePoc } from './VoicePoc';
import { WsProbe } from './WsProbe';
import { ScreenHeader } from './ScreenHeader';

/**
 * Settings screen (docs/MEDIA_ATTACHMENTS.md §5.6) — pushed from the Profile
 * tab's landing page (`{ name: 'settings' }` in App.tsx's `View` union;
 * `parentOf` unwinds Settings → Profile → Chats). Holds the app's first real
 * user preference plus the sections that used to live directly on Profile.
 */
export function Settings({ me, onBack }: { me: MeResponse; onBack: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Settings" onBack={onBack} />
      <div
        className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
        style={{
          paddingLeft: 'max(env(safe-area-inset-left), 1rem)',
          paddingRight: 'max(env(safe-area-inset-right), 1rem)',
        }}
      >
        <MediaPrivacySection me={me} />
        <NotificationsSection />
        <VaultLinkSection />
        <DebugTools />
      </div>
    </div>
  );
}

/** "Media & privacy" — the first `users.settings` preference
 *  (docs/MEDIA_ATTACHMENTS.md D11): whether the gallery renders NSFW/spoiler
 *  media unblurred by default. Chat never reads this setting — it always
 *  blurs (docs §5.5, the deliberate chat-vs-gallery split). */
function MediaPrivacySection({ me }: { me: MeResponse }) {
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: (value: boolean) => updateMe({ settings: { galleryShowSensitive: value } }),
    onSuccess: (user) => qc.setQueryData(['me'], user),
  });

  const checked = me.settings.galleryShowSensitive;

  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4">
      <h3 className="text-sm font-semibold text-text-primary">Media & privacy</h3>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-sm text-text-primary">Always show sensitive media in Gallery</span>
        <Switch checked={checked} onChange={(v) => save.mutate(v)} disabled={save.isPending} />
      </div>
      <p className="mt-2 text-xs text-text-secondary">
        Chat still blurs NSFW and spoiler media — the gallery is a place you opened on purpose.
      </p>

      {save.isError && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">Could not save — try again.</p>
      )}
    </section>
  );
}

/** Plain hand-rolled on/off switch — this codebase has no toggle component
 *  and CLAUDE.md forbids adding a UI-primitive dependency for one. Token
 *  colors only (bg-accent / bg-surface-sunken), no new colors. */
function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        'relative h-6 w-11 shrink-0 rounded-pill transition-colors disabled:opacity-40 ' +
        (checked ? 'bg-accent' : 'border border-border bg-surface-sunken')
      }
      style={{ touchAction: 'manipulation' }}
    >
      <span
        className={
          'absolute left-0.5 top-0.5 h-5 w-5 rounded-pill bg-white transition-transform ' +
          (checked ? 'translate-x-[20px]' : 'translate-x-0')
        }
      />
    </button>
  );
}

/** Collapsible home for the Stage 0 PoCs, moved here from the Profile tab
 *  (docs/MEDIA_ATTACHMENTS.md §5.6) — handy for real-device testing (CLAUDE.md:
 *  "keeping debugging easy for future testing"). "Enable notifications" moved
 *  out to `NotificationsSection` above; "Send test" stays here. */
function DebugTools() {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border border-black/10 bg-white dark:border-white/10 dark:bg-neutral-900">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold"
      >
        Debug tools
        <span className="text-neutral-400">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t border-black/10 p-4 dark:border-white/10">
          <PushPoc />
          <VoicePoc />
          <WsProbe />
        </div>
      )}
    </section>
  );
}
