import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableError, ValidationError } from '@shared/errors/app-error';
import type { GuardedOpenAiTranscriber } from '@modules/ai-gateway/infrastructure/guarded-openai-client';
import { m4aDurationSeconds } from './m4a-duration';
import { cleanTranscript, parseVoiceUpload, VOICE_TRANSCRIPTION_PROMPT, VoiceTranscriptionService } from './voice-transcription';

function box(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + content.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const content = Buffer.alloc(100);
  content.writeUInt32BE(timescale, 12);
  content.writeUInt32BE(duration, 16);
  return box('mvhd', content);
}

function mvhdV1(timescale: number, duration: number): Buffer {
  const content = Buffer.alloc(112);
  content.writeUInt8(1, 0);
  content.writeUInt32BE(timescale, 20);
  content.writeBigUInt64BE(BigInt(duration), 24);
  return box('mvhd', content);
}

/** ftyp, then mdat before moov, as AVAudioRecorder writes it. */
function m4a(mvhd: Buffer): Buffer {
  return Buffer.concat([box('ftyp', Buffer.from('M4A \0\0\0\0M4A mp42isom', 'latin1')), box('mdat', Buffer.alloc(64, 7)), box('moov', Buffer.concat([mvhd, box('trak', Buffer.alloc(16))]))]);
}

function upload(data: Buffer, contentType = 'audio/mp4') {
  return { content_type: contentType, data_base64: data.toString('base64') };
}

describe('m4aDurationSeconds', () => {
  it('reads the length from mvhd version 0 and 1, wherever moov is', () => {
    expect(m4aDurationSeconds(m4a(mvhdV0(44_100, 441_000)))).toBe(10);
    expect(m4aDurationSeconds(m4a(mvhdV1(1000, 2500)))).toBe(2.5);
  });

  it('is null for anything that is not an MPEG-4 file with a length', () => {
    expect(m4aDurationSeconds(Buffer.from('not audio at all'))).toBeNull();
    expect(m4aDurationSeconds(Buffer.concat([box('ftyp', Buffer.alloc(8)), box('mdat', Buffer.alloc(8))]))).toBeNull();
    expect(m4aDurationSeconds(m4a(mvhdV0(0, 100)))).toBeNull();
    expect(m4aDurationSeconds(m4a(mvhdV0(1000, 0xffffffff)))).toBeNull();
    // A box claiming more bytes than the file has.
    const truncated = m4a(mvhdV0(1000, 2000));
    expect(m4aDurationSeconds(truncated.subarray(0, truncated.length - 20))).toBeNull();
  });
});

describe('parseVoiceUpload', () => {
  it('takes an .m4a recording and its length from the file', () => {
    const parsed = parseVoiceUpload(upload(m4a(mvhdV0(1000, 12_300))));
    expect(parsed.duration_seconds).toBe(12.3);
    expect(parsed.audio.length).toBeGreaterThan(0);
    expect(parseVoiceUpload(upload(m4a(mvhdV0(1000, 1000)), 'audio/x-m4a')).duration_seconds).toBe(1);
  });

  it('refuses other types, non-MPEG-4 data, too short and too long recordings', () => {
    expect(() => parseVoiceUpload(upload(m4a(mvhdV0(1000, 1000)), 'audio/wav'))).toThrow(ValidationError);
    expect(() => parseVoiceUpload({ content_type: 'audio/mp4' })).toThrow(ValidationError);
    expect(() => parseVoiceUpload(upload(Buffer.from('RIFF....WAVE')))).toThrow(ValidationError);
    expect(() => parseVoiceUpload(upload(Buffer.alloc(0)))).toThrow(ValidationError);
    expect(() => parseVoiceUpload(upload(m4a(mvhdV0(1000, 200))))).toThrow(/too short/);
    expect(() => parseVoiceUpload(upload(m4a(mvhdV0(1000, 122_000))))).toThrow(/at most 120 seconds/);
    expect(() => parseVoiceUpload(upload(Buffer.alloc(3 * 1024 * 1024 + 1)))).toThrow(/at most 3 MB/);
  });
});

describe('cleanTranscript', () => {
  it('collapses whitespace and drops an echo of the prompt', () => {
    expect(cleanTranscript('  Cukier   145,\n strzałka w górę ')).toBe('Cukier 145, strzałka w górę');
    expect(cleanTranscript('   ')).toBe('');
    expect(cleanTranscript(VOICE_TRANSCRIPTION_PROMPT)).toBe('');
    expect(cleanTranscript('Trio, Nightscout, Dexcom')).toBe('');
  });
});

describe('VoiceTranscriptionService', () => {
  const audio = parseVoiceUpload(upload(m4a(mvhdV0(1000, 4000))));

  it('sends the recording in Polish with the domain prompt and returns the cleaned text', async () => {
    const transcribe = vi.fn<GuardedOpenAiTranscriber['transcribe']>(async () => ({ text: ' Podałem bolus 2 j. ', billed_seconds: 4, cost: 0.0003 }));
    const service = new VoiceTranscriptionService({ transcribe }, 'gpt-transcribe');

    await expect(service.transcribe(audio)).resolves.toEqual({ text: 'Podałem bolus 2 j.', duration_seconds: 4 });
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-transcribe', filename: 'voice.m4a', duration_seconds: 4, languages: ['pl'], prompt: VOICE_TRANSCRIPTION_PROMPT }),
      { timeout: 30_000 },
    );
  });

  it('turns any provider or guard failure into 503', async () => {
    const service = new VoiceTranscriptionService({ transcribe: async () => { throw new Error('AI_COST_LIMIT_REFUSED'); } }, 'gpt-transcribe');
    await expect(service.transcribe(audio)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('is off unless enabled, and off (not a crash) when the guard is not configured', () => {
    expect(VoiceTranscriptionService.fromEnv({})).toBeNull();
    expect(VoiceTranscriptionService.fromEnv({ VOICE_TRANSCRIPTION_ENABLED: 'false', OPENAI_API_KEY: 'sk' })).toBeNull();
    expect(VoiceTranscriptionService.fromEnv({ VOICE_TRANSCRIPTION_ENABLED: 'true' })).toBeNull();
    expect(VoiceTranscriptionService.fromEnv({ VOICE_TRANSCRIPTION_ENABLED: 'true', OPENAI_API_KEY: 'sk' })).toBeNull();
  });
});

describe('cleanTranscript and a partly echoed prompt', () => {
  it('drops a transcript made of the prompt\'s sample phrases, keeps a real one with one of them', async () => {
    const { cleanTranscript } = await import('./voice-transcription');
    expect(cleanTranscript('Cukier 145 mg/dl, strzałka w dół. Bolus 2,5 j.')).toBe('');
    expect(cleanTranscript('Ile podać na obiad? Strzałka w dół od godziny.')).toBe('Ile podać na obiad? Strzałka w dół od godziny.');
  });
});
