import { useRef, useState } from 'react';
import { Circle, Square } from 'lucide-react';
import { ApiFetchError } from '../lib/api';

type Phase = 'idle' | 'recording' | 'uploading' | 'ready' | 'error';

/**
 * Stage 0 GO/NO-GO panel for the voice path (BACKBONE §7, §14).
 * Records with MediaRecorder (whatever format the platform gives —
 * audio/mp4 on iOS Safari, audio/webm;opus on Chrome), uploads, and plays back
 * the server-normalized m4a. If the returned clip plays on iPhone, the pipeline
 * is validated.
 */
export function VoicePoc() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState('');
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [inputType, setInputType] = useState('');

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  async function start() {
    setMsg('');
    setClipUrl(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Let the platform pick its native container; we only record, server normalizes.
      const rec = new MediaRecorder(stream);
      setInputType(rec.mimeType || '(default)');
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => void upload();
      recRef.current = rec;
      rec.start();
      setPhase('recording');
    } catch (e) {
      setPhase('error');
      setMsg(e instanceof Error ? e.message : 'Mic access failed');
    }
  }

  function stop() {
    recRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setPhase('uploading');
  }

  async function upload() {
    try {
      const blob = new Blob(chunksRef.current, { type: recRef.current?.mimeType || 'audio/webm' });
      const form = new FormData();
      form.append('file', blob, 'clip');
      const res = await fetch('/api/voice-poc/upload', {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { code: string; message: string } }
          | null;
        throw new ApiFetchError(res.status, body?.error?.code ?? 'internal', body?.error?.message ?? 'Upload failed');
      }
      const { id, sizeBytes } = (await res.json()) as { id: string; sizeBytes: number };
      // Cache-bust so the <audio> element always fetches the fresh clip.
      setClipUrl(`/api/voice-poc/${id}?t=${Date.now()}`);
      setPhase('ready');
      setMsg(`Transcoded → m4a (${(sizeBytes / 1024).toFixed(0)} KB). Tap play to verify on this device.`);
    } catch (e) {
      setPhase('error');
      setMsg(e instanceof ApiFetchError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : 'Upload failed');
    }
  }

  return (
    <section className="rounded-lg border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-neutral-900">
      <h2 className="text-base font-semibold">Voice PoC</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Record → server ffmpeg → m4a/AAC → play back. Validates the cross-platform voice path (§7).
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {phase !== 'recording' ? (
          <button
            onClick={start}
            disabled={phase === 'uploading'}
            className="flex items-center gap-1.5 rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            <Circle size={14} fill="currentColor" />
            Record
          </button>
        ) : (
          <button
            onClick={stop}
            className="flex items-center gap-1.5 rounded-md bg-neutral-800 px-4 py-2 text-sm font-medium text-white dark:bg-neutral-200 dark:text-black"
          >
            <Square size={14} fill="currentColor" />
            Stop
          </button>
        )}
        {phase === 'recording' && <span className="text-sm text-rose-500">recording…</span>}
        {phase === 'uploading' && <span className="text-sm text-neutral-500">transcoding…</span>}
      </div>

      {inputType && (
        <p className="mt-2 text-xs text-neutral-400">
          Recorder gave: <code>{inputType}</code>
        </p>
      )}

      {clipUrl && (
        // Native controls; iOS requires the play tap to be a user gesture — this is one.
        <audio className="mt-3 w-full" controls src={clipUrl} preload="metadata" />
      )}

      {msg && (
        <p
          className={
            'mt-3 text-sm ' +
            (phase === 'error' ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400')
          }
        >
          {msg}
        </p>
      )}
    </section>
  );
}
