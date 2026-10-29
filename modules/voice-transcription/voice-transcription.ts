import { Logger } from '@nestjs/common';
import { readBooleanFlag } from '@infra/config/environment';
import { ServiceUnavailableError, ValidationError } from '@shared/errors/app-error';
import { createGuardedOpenAiTranscriberFromEnv, type GuardedOpenAiTranscriber } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { m4aDurationSeconds } from './m4a-duration';

/**
 * Voice input of the chat composers: the app records a short message (.m4a) and gets its text back to edit and send
 * like a typed one. The audio is transcribed and dropped, never stored; the cost goes through the AI ledger.
 */

/** Longest recording the app sends (it stops recording there) and the shortest worth a call. */
export const VOICE_MAX_SECONDS = 120;
export const VOICE_MIN_SECONDS = 0.3;
/** 120 s of AAC at the app's 32 kbit/s is under 0.5 MB; the limit leaves room for other bit rates. */
export const VOICE_MAX_BYTES = 3 * 1024 * 1024;

const ACCEPTED_CONTENT_TYPES = new Set(['audio/mp4', 'audio/m4a', 'audio/x-m4a']);

export interface VoiceUpload {
  audio: Buffer;
  duration_seconds: number;
}

/** The body of POST …/transcriptions: an .m4a recording as base64, its length read from the file. */
export function parseVoiceUpload(input: { content_type?: unknown; data_base64?: unknown }): VoiceUpload {
  if (typeof input.content_type !== 'string' || !ACCEPTED_CONTENT_TYPES.has(input.content_type) || typeof input.data_base64 !== 'string') {
    throw new ValidationError('content_type must be audio/mp4 and data_base64 a base64 string');
  }
  const audio = Buffer.from(input.data_base64, 'base64');
  if (audio.length === 0 || audio.length > VOICE_MAX_BYTES) {
    throw new ValidationError('The recording must be an .m4a file of at most 3 MB');
  }
  const duration = m4aDurationSeconds(audio);
  if (duration === null) throw new ValidationError('The recording must be an .m4a file with its length');
  if (duration < VOICE_MIN_SECONDS) throw new ValidationError('The recording is too short');
  // A second of slack: the recorder stops at VOICE_MAX_SECONDS and the file may state a little more.
  if (duration > VOICE_MAX_SECONDS + 1) throw new ValidationError(`The recording must be at most ${VOICE_MAX_SECONDS} seconds long`);
  return { audio, duration_seconds: duration };
}

/**
 * Context for the model, written as a sample of what is said in the app: the words it would otherwise mishear (insulin
 * and device names, WW/WBT) and the style (numbers as digits, units as written in the chat). In Polish, the language
 * of the audio, as OpenAI recommends.
 */
export const VOICE_TRANSCRIPTION_PROMPT =
  'Cukier 145 mg/dl, strzałka w dół, hipo o 3:00, dosłodzenie 10 g. Bolus 2,5 j. Fiaspu na 3 WW i 1,5 WBT. ' +
  'Trio, Nightscout, Dexcom, Loop, AAPS, Libre, sensor, pompa, baza, korekta, węglowodany, białko, tłuszcz, posiłek, IOB, COB.';

export interface VoiceTranscription {
  text: string;
  duration_seconds: number;
}

export class VoiceTranscriptionService {
  private readonly logger = new Logger(VoiceTranscriptionService.name);

  constructor(
    private readonly transcriber: GuardedOpenAiTranscriber,
    private readonly model: string,
    private readonly timeoutMs = 30_000,
  ) {}

  /**
   * On only with VOICE_TRANSCRIPTION_ENABLED=true, an OpenAI key and a complete guard configuration; a missing price or
   * ledger keeps it off (logged) instead of stopping the API. Off, GET /v1/app-config tells the app to transcribe on the
   * phone (Apple Speech), so a server with only a Claude key still has voice input.
   */
  static fromEnv(env: NodeJS.ProcessEnv): VoiceTranscriptionService | null {
    const logger = new Logger(VoiceTranscriptionService.name);
    if (!readBooleanFlag(env, 'VOICE_TRANSCRIPTION_ENABLED')) {
      logger.log('Voice input: transcribed on the phone (VOICE_TRANSCRIPTION_ENABLED is off)');
      return null;
    }
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      logger.log('Voice input: transcribed on the phone (no OPENAI_API_KEY; server transcription needs OpenAI)');
      return null;
    }
    try {
      const model = env.OPENAI_TRANSCRIPTION_MODEL?.trim() || 'gpt-transcribe';
      const service = new VoiceTranscriptionService(createGuardedOpenAiTranscriberFromEnv(env, apiKey), model);
      logger.log(`Voice input: transcribed on the server (${model})`);
      return service;
    } catch (error) {
      logger.error(`Voice transcription on the server is off, the phone transcribes instead: ${(error as Error).message}`);
      return null;
    }
  }

  async transcribe(upload: VoiceUpload): Promise<VoiceTranscription> {
    const startedAt = Date.now();
    try {
      const result = await this.transcriber.transcribe(
        {
          model: this.model,
          audio: upload.audio,
          filename: 'voice.m4a',
          duration_seconds: upload.duration_seconds,
          languages: ['pl'],
          prompt: VOICE_TRANSCRIPTION_PROMPT,
        },
        { timeout: this.timeoutMs },
      );
      const text = cleanTranscript(result.text);
      this.logger.log(`voice transcription: ${upload.duration_seconds.toFixed(1)} s audio, billed ${result.billed_seconds ?? 'unknown'} s, cost ${result.cost.toFixed(5)}, ${text.length} chars, ${Date.now() - startedAt} ms`);
      return { text, duration_seconds: upload.duration_seconds };
    } catch (error) {
      this.logger.warn(`voice transcription failed after ${Date.now() - startedAt} ms: ${(error as Error).message}`);
      throw new ServiceUnavailableError('Voice transcription failed');
    }
  }
}

/**
 * The text to put in the composer. Silence can make a model repeat its prompt; such an echo reads as nothing said.
 */
export function cleanTranscript(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (VOICE_TRANSCRIPTION_PROMPT.includes(text) || text.includes(VOICE_TRANSCRIPTION_PROMPT)) return '';
  // A partly echoed prompt (near-silent audio) would put its sample numbers ("Bolus 2,5 j") into the message: two or
  // more of its sample phrases in one transcript are taken as an echo.
  const lower = text.toLowerCase();
  if (PROMPT_SAMPLE_PHRASES.filter((phrase) => lower.includes(phrase)).length >= 2) return '';
  return text;
}

const PROMPT_SAMPLE_PHRASES = ['cukier 145 mg/dl', 'strzałka w dół', 'hipo o 3:00', 'dosłodzenie 10 g', 'bolus 2,5 j', 'fiaspu na 3 ww', '1,5 wbt'];
