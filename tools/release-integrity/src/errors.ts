export class ReleaseIntegrityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReleaseIntegrityError";
    this.code = code;
  }
}

export function releaseError(code: string, message: string): never {
  throw new ReleaseIntegrityError(code, message);
}
