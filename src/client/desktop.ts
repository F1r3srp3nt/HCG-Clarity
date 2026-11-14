/**
 * The desktop app's bridge (desktop/preload.ts), or undefined in a normal browser.
 * The bridge never returns provider keys: only whether one is saved.
 */
export type DesktopProvider = 'anthropic' | 'elevenlabs';

export interface DesktopBackendStatus {
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  error: string | null;
  restarts: number;
}

export interface DesktopCredentialStatus {
  storage: { secure: boolean; name: string };
  providers: Record<DesktopProvider, { saved: boolean }>;
  backend: DesktopBackendStatus;
}

export type DesktopFileKind = 'project' | 'pptx' | 'zip' | 'markdown' | 'text' | 'json';

export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  credentials: {
    status(): Promise<DesktopCredentialStatus>;
    save(provider: DesktopProvider, key: string): Promise<DesktopCredentialStatus>;
    clear(provider: DesktopProvider): Promise<DesktopCredentialStatus>;
  };
  files: {
    save(kind: DesktopFileKind, suggestedName: string, bytes: Uint8Array): Promise<{ saved: false } | { saved: true; fileName: string }>;
    openProject(): Promise<{ opened: false } | { opened: true; fileName: string; bytes: Uint8Array }>;
  };
  backend: {
    status(): Promise<DesktopBackendStatus>;
    restart(): Promise<DesktopBackendStatus>;
    onChange(listener: (status: DesktopBackendStatus) => void): () => void;
  };
}

export const desktop: DesktopBridge | undefined = (globalThis as { hcgClarityDesktop?: DesktopBridge }).hcgClarityDesktop;

/** Bridge errors arrive as "Error invoking remote method …: Error: <message>"; keep the message. */
export function bridgeMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
