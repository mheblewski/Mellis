import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Meal photos on the server's disk: <MEAL_PHOTO_DIR>/<patient id>/<photo id>.jpg. Paths are built only from UUIDs,
 * so no request value can reach outside the directory.
 */
export class MealPhotoStorage {
  constructor(private readonly rootDir: string) {}

  static fromEnv(env: NodeJS.ProcessEnv): MealPhotoStorage | null {
    const dir = env.MEAL_PHOTO_DIR?.trim();
    return dir ? new MealPhotoStorage(dir) : null;
  }

  async save(patientId: string, photoId: string, data: Buffer): Promise<void> {
    const target = this.pathFor(patientId, photoId);
    await mkdir(join(this.rootDir, patientId), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, target);
  }

  async read(patientId: string, photoId: string): Promise<Buffer> {
    return readFile(this.pathFor(patientId, photoId));
  }

  private pathFor(patientId: string, photoId: string): string {
    if (!UUID_PATTERN.test(patientId) || !UUID_PATTERN.test(photoId)) {
      throw new Error('INVALID_PHOTO_PATH');
    }
    return join(this.rootDir, patientId, `${photoId}.jpg`);
  }
}

/** JPEG files start with FF D8 FF. */
export function isJpeg(data: Buffer): boolean {
  return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}
