import { readFileSync } from 'node:fs';

/**
 * What the app needs to know before anything else: the oldest iOS build this server still works with. Builds are
 * numbered by the app's build script with the commit count of main (`git rev-list --count HEAD`), so a build made from
 * a later commit always has a higher number.
 */

/**
 * Raise this when a server change needs a newer app (a build older than this shows the update banner).
 * 1: the public repository's history starts at 1.0.0 (one commit), so its builds count from 1 again; raise this to the
 * public commit count of the first build that a later server change needs.
 */
export const IOS_MIN_SUPPORTED_BUILD = 1;

export const IOS_UPDATE_MESSAGE = 'Ta wersja aplikacji jest nieaktualna. Zainstaluj nową wersję, żeby korzystać z nowych ekranów (np. hipo).';

export interface AppConfigResponse {
  ios: {
    min_build: number;
    update_message: string;
  };
  /** Which server release answers: the update check of the server tool and the app compare it with the newest one. */
  server: {
    /** Release version from the image (MELLIS_VERSION, e.g. "0.2.0"); null for a server built by hand. */
    version: string | null;
    /** Commit the server was built from (MELLIS_REVISION, else the REVISION file ship.sh writes); null if unknown. */
    revision: string | null;
  };
  voice: {
    /**
     * true: the mic's recordings go to the server (POST …/transcriptions, OpenAI). false (no OpenAI key, or voice off on
     * the server): the app transcribes on the phone (Apple Speech). Older apps ignore it.
     */
    server_transcription: boolean;
  };
}

/** IOS_MIN_SUPPORTED_BUILD in the environment overrides the constant (e.g. 0 to switch the banner off). */
export function buildAppConfig(
  env: Record<string, string | undefined> = process.env,
  server: { voice_transcription: boolean } = { voice_transcription: false },
  readRevisionFile: () => string | null = readShippedRevision,
): AppConfigResponse {
  const override = Number.parseInt(String(env.IOS_MIN_SUPPORTED_BUILD ?? ''), 10);
  return {
    ios: {
      min_build: Number.isFinite(override) && override >= 0 ? override : IOS_MIN_SUPPORTED_BUILD,
      update_message: IOS_UPDATE_MESSAGE,
    },
    server: {
      version: nonEmpty(env.MELLIS_VERSION),
      revision: nonEmpty(env.MELLIS_REVISION) ?? readRevisionFile(),
    },
    voice: { server_transcription: server.voice_transcription },
  };
}

function nonEmpty(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

let shippedRevision: string | null | undefined;

/** REVISION next to the app (written by a deploy script), read once: it never changes while the process runs. */
function readShippedRevision(): string | null {
  if (shippedRevision === undefined) {
    try {
      shippedRevision = nonEmpty(readFileSync('REVISION', 'utf8'));
    } catch {
      shippedRevision = null;
    }
  }
  return shippedRevision;
}
