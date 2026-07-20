import { isIosSafari, isStandalone } from '../lib/pwa';

/**
 * Nudges iOS Safari users to install the PWA — push + reliable storage only
 * work once "Add to Home Screen" is done (BACKBONE §8, §9). Hidden when already
 * installed or when not iOS Safari (Android/desktop get a native install prompt).
 */
export function InstallInstructions() {
  if (isStandalone() || !isIosSafari()) return null;

  return (
    <div className="rounded-lg border border-amber-300/40 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/20 dark:bg-amber-950/40 dark:text-amber-200">
      <p className="font-semibold">Install Den to your Home Screen</p>
      <p className="mt-1 opacity-90">
        Push notifications and offline start only work from the installed app on iPhone.
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        <li>
          Tap the <span className="font-semibold">Share</span> icon (the square with an up-arrow).
        </li>
        <li>
          Choose <span className="font-semibold">Add to Home Screen</span>.
        </li>
        <li>Open Den from the new Home Screen icon.</li>
      </ol>
    </div>
  );
}
