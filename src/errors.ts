export type AuthKitErrorCode =
  | "snapshot_invalid"
  | "token_invalid"
  | "token_request_failed"
  | "keys_unavailable"
  | "actor_forbidden"
  | "not_implemented"

/** Every error the SDK throws on purpose. `code` is stable; `message` is for logs only. */
export class AuthKitError extends Error {
  override readonly name = "AuthKitError"

  constructor(
    readonly code: AuthKitErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

/** Placeholder for scaffolded modules; removed as each module is implemented. */
export function notImplemented(feature: string): never {
  throw new AuthKitError("not_implemented", `${feature} is not implemented yet`)
}
