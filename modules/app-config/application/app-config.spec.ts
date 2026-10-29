import { describe, expect, it } from 'vitest';
import { buildAppConfig, IOS_MIN_SUPPORTED_BUILD } from './app-config';

describe('app config', () => {
  it('sends the minimum iOS build with the update message', () => {
    expect(buildAppConfig({}, undefined, () => null)).toEqual({
      ios: { min_build: IOS_MIN_SUPPORTED_BUILD, update_message: expect.stringContaining('Zainstaluj nową wersję') },
      server: { version: null, revision: null },
      voice: { server_transcription: false },
    });
  });

  it('tells the app whether the server transcribes voice (otherwise the phone does)', () => {
    expect(buildAppConfig({}, { voice_transcription: true }).voice).toEqual({ server_transcription: true });
    expect(buildAppConfig({}, { voice_transcription: false }).voice).toEqual({ server_transcription: false });
  });

  it('lets the environment override the minimum build', () => {
    expect(buildAppConfig({ IOS_MIN_SUPPORTED_BUILD: '0' }).ios.min_build).toBe(0);
    expect(buildAppConfig({ IOS_MIN_SUPPORTED_BUILD: '120' }).ios.min_build).toBe(120);
    expect(buildAppConfig({ IOS_MIN_SUPPORTED_BUILD: 'abc' }).ios.min_build).toBe(IOS_MIN_SUPPORTED_BUILD);
    expect(buildAppConfig({ IOS_MIN_SUPPORTED_BUILD: '-3' }).ios.min_build).toBe(IOS_MIN_SUPPORTED_BUILD);
  });

  it('names the server release from the image, else the shipped REVISION file', () => {
    expect(buildAppConfig({ MELLIS_VERSION: '0.2.0', MELLIS_REVISION: 'abc1234' }, undefined, () => 'def5678').server).toEqual({
      version: '0.2.0',
      revision: 'abc1234',
    });
    expect(buildAppConfig({ MELLIS_VERSION: ' ', MELLIS_REVISION: '' }, undefined, () => 'def5678').server).toEqual({
      version: null,
      revision: 'def5678',
    });
  });
});
